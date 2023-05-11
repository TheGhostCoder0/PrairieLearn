// @ts-check
const AWS = require('aws-sdk');
const _ = require('lodash');
const ERR = require('async-stacktrace');
const fs = require('fs-extra');
const async = require('async');
const Docker = require('dockerode');
const { logger } = require('@prairielearn/logger');
const { DockerName, setupDockerAuth } = require('@prairielearn/docker-utils');

const { config } = require('../../lib/config');
const serverJobs = require('../../lib/server-jobs-legacy');
const { createServerJob } = require('../../lib/server-jobs');
const syncFromDisk = require('../../sync/syncFromDisk');
const requireFrontend = require('../../lib/require-frontend');
const courseUtil = require('../../lib/courseUtil');
const util = require('util');
const chunks = require('../../lib/chunks');
const debug = require('debug')('prairielearn:syncHelpers');

const error = require('@prairielearn/error');

const docker = new Docker();

module.exports.pullAndUpdate = async function (locals) {
  const serverJob = await createServerJob({
    courseId: locals.course.id,
    userId: locals.user.user_id,
    authnUserId: locals.authz_data.authn_user.user_id,
    type: 'sync',
    description: 'Pull from remote git repository',
  });

  const gitEnv = process.env;
  if (config.gitSshCommand != null) {
    gitEnv.GIT_SSH_COMMAND = config.gitSshCommand;
  }

  serverJob.executeInBackground(async (job) => {
    let startGitHash = null;
    const coursePathExists = await fs.pathExists(locals.course.path);
    if (coursePathExists) {
      // path does not exist, start with 'git clone'
      job.info('Clone from remote git repository');
      await job.exec(
        'git',
        ['clone', '-b', locals.course.branch, locals.course.repository, locals.course.path],
        {
          // Executed in the root directory, but this shouldn't really matter.
          cwd: '/',
          env: gitEnv,
        }
      );
    } else {
      // path exists, update remote origin address, then 'git fetch' and reset to latest with 'git reset'

      startGitHash = await courseUtil.getOrUpdateCourseCommitHashAsync(locals.course);

      job.info('Updating to latest remote origin address');
      await job.exec('git', ['remote', 'set-url', 'origin', locals.course.repository], {
        cwd: locals.course.path,
        env: gitEnv,
      });

      job.info('Fetch from remote git repository');
      await job.exec('git', ['fetch'], { cwd: locals.course.path, env: gitEnv });

      job.info('Clean local files not in remote git repository');
      await job.exec('git', ['clean', '-fdx'], { cwd: locals.course.path, env: gitEnv });

      job.info('Reset state to remote git repository');
      await job.exec('git', ['reset', '--hard', `origin/${locals.course.branch}`], {
        cwd: locals.course.path,
        env: gitEnv,
      });
    }

    // After either cloning or fetching and resetting from Git, we'll load the
    // current commit hash. Note that we don't commit this to the database until
    // after we've synced the changes to the database and generated chunks. This
    // ensures that if the sync fails, we'll sync from the same starting commit
    // hash next time.
    const endGitHash = await courseUtil.getCommitHashAsync(locals.course.path);

    job.info('Sync git repository to database');
    const syncResult = await syncFromDisk.syncDiskToSqlAsync(
      locals.course.path,
      locals.course.id,
      job
    );

    if (config.chunksGenerator) {
      const chunkChanges = await chunks.updateChunksForCourse({
        coursePath: locals.course.path,
        courseId: locals.course.id,
        courseData: syncResult.courseData,
        oldHash: startGitHash,
        newHash: endGitHash,
      });
      chunks.logChunkChangesToJob(chunkChanges, job);
    }

    await courseUtil.updateCourseCommitHashAsync(locals.course);

    // Before erroring the job from sync errors, reload server.js files.
    job.info('Reload question server.js files');
    const coursePath = locals.course.path;
    await util.promisify(requireFrontend.undefQuestionServers)(coursePath, job);

    if (syncResult.hadJsonErrors) {
      throw new Error('One or more JSON files contained errors and were unable to be synced');
    }
  });

  return serverJob.jobSequenceId;
};

module.exports.gitStatus = async function (locals) {
  const serverJob = await createServerJob({
    courseId: locals.course.id,
    userId: locals.user.user_id,
    authnUserId: locals.authz_data.authn_user.user_id,
    type: 'git_status',
    description: 'Show server git status',
  });

  serverJob.executeInBackground(async (job) => {
    job.info('Describe current git HEAD');
    await job.exec('git', ['show', '--format=fuller', '--quiet', 'HEAD'], {
      cwd: locals.course.path,
    });

    job.info('List git history');
    await job.exec(
      'git',
      ['log', '--all', '--graph', '--date=short', '--format=format:%h %cd%d %cn %s'],
      {
        cwd: locals.course.path,
      }
    );
  });

  return serverJob.jobSequenceId;
};

function locateImage(image, callback) {
  debug('locateImage');
  docker.listImages(function (err, list = []) {
    if (ERR(err, callback)) return;
    debug(`locateImage: list=${list}`);
    for (var i = 0, len = list.length; i < len; i++) {
      if (list[i].RepoTags && list[i].RepoTags?.indexOf(image) !== -1) {
        return callback(null, docker.getImage(list[i].Id));
      }
    }
    return callback(new Error(`Unable to find image=${image}`));
  });
}

function confirmOrCreateECRRepo(repo, job, callback) {
  const ecr = new AWS.ECR();
  job.info(`Describing repositories with name: ${repo}`);
  ecr.describeRepositories({ repositoryNames: [repo] }, (err, data) => {
    let repositoryFound = false;
    if (err) {
      job.info(`Error returned from describeRepositories(): ${err}`);
      job.info('Treating this error as meaning the desired repository does not exist');
    } else {
      repositoryFound = !!_.find(data.repositories, ['repositoryName', repo]);
    }

    if (!repositoryFound) {
      job.info('Repository not found');

      job.info(`Creating repository: ${repo}`);
      var params = {
        repositoryName: repo,
      };
      ecr.createRepository(params, (err) => {
        if (ERR(err, callback)) return;
        job.info('Successfully created repository');
        callback(null);
      });
    } else {
      job.info('Repository found');
      // Already exists, nothing to do
      callback(null);
    }
  });
}

function logProgressOutput(output, job, printedInfos, prefix) {
  let info = null;
  if (
    'status' in output &&
    'id' in output &&
    'progressDetail' in output &&
    output.progressDetail.total
  ) {
    info = `${output.status} ${output.id} (${output.progressDetail.total} bytes)`;
  } else if ('status' in output && 'id' in output) {
    info = `${output.status} ${output.id}`;
  } else if ('status' in output) {
    info = `${output.status}`;
  }
  if (info != null && !printedInfos.has(info)) {
    printedInfos.add(info);
    job.info(prefix + info);
  }
}

function pullAndPushToECR(image, dockerAuth, job, callback) {
  debug(`pullAndPushtoECR for ${image}`);

  const { cacheImageRegistry } = config;
  if (!cacheImageRegistry) {
    return callback(new Error('cacheImageRegistry not defined'));
  }

  const repository = new DockerName(image);
  const params = {
    fromImage: repository.getRepository(),
    tag: repository.getTag() || 'latest',
  };
  job.info(`Pulling ${repository.getCombined()}`);
  docker.createImage({}, params, (err, stream) => {
    if (ERR(err, callback)) return;
    if (!stream) throw new Error('Missing stream from createImage()');

    const printedInfos = new Set();
    docker.modem.followProgress(
      stream,
      (err) => {
        if (ERR(err, callback)) return;

        job.info('Pull complete');

        // Find the image we just downloaded
        const downloadedImage = repository.getCombined(true);
        job.info(`Locating downloaded image: ${downloadedImage}`);
        locateImage(downloadedImage, (err, localImage) => {
          if (ERR(err, callback)) return;
          job.info('Successfully located downloaded image');

          // Tag the image to add the new registry
          repository.setRegistry(cacheImageRegistry);

          var options = {
            repo: repository.getCombined(),
          };
          job.info(`Tagging image: ${options.repo}`);
          localImage.tag(options, (err) => {
            if (ERR(err, callback)) return;
            job.info('Successfully tagged image');

            const repositoryName = repository.getRepository();
            job.info(`Ensuring repository exists: ${repositoryName}`);
            confirmOrCreateECRRepo(repositoryName, job, (err) => {
              if (ERR(err, callback)) return;
              job.info('Successfully ensured repository exists');

              // Create a new docker image instance with the new registry name
              // localImage isn't specific enough to the ECR repo
              const pushImageName = repository.getCombined();
              var pushImage = new Docker.Image(docker.modem, pushImageName);

              job.info(`Pushing image: ${repository.getCombined()}`);
              pushImage.push(
                {
                  authconfig: dockerAuth,
                },
                (err, stream) => {
                  if (ERR(err, callback)) return;
                  if (!stream) throw new Error('Missing stream from push()');

                  const printedInfos = new Set();
                  docker.modem.followProgress(
                    stream,
                    (err) => {
                      if (ERR(err, callback)) return;
                      job.info('Push complete');
                      callback(null);
                    },
                    (output) => {
                      logProgressOutput(output, job, printedInfos, 'Push progress: ');
                    }
                  );
                }
              );
            });
          });
        });
      },
      (output) => {
        logProgressOutput(output, job, printedInfos, 'Pull progress: ');
      }
    );
  });
}

module.exports.ecrUpdate = function (locals, callback) {
  if (!config.cacheImageRegistry) {
    return callback(new Error('cacheImageRegistry not defined'));
  }

  setupDockerAuth(config.awsRegion, config.cacheImageRegistry, (err, auth) => {
    if (ERR(err, callback)) return;

    const options = {
      course_id: locals.course.id,
      user_id: locals.user.user_id,
      authn_user_id: locals.authz_data.authn_user.user_id,
      type: 'images_sync',
      description: 'Sync Docker images from Docker Hub to PL registry',
    };
    serverJobs.createJobSequence(options, function (err, job_sequence_id) {
      if (ERR(err, callback)) return;
      callback(null, job_sequence_id);

      var lastIndex = locals.images.length - 1;
      async.eachOfSeries(
        locals.images || [],
        (image, index, callback) => {
          var jobOptions = {
            course_id: locals.course ? locals.course.id : null,
            type: 'image_sync',
            description: `Pull image from Docker Hub and push to PL registry: ${image.image}`,
            job_sequence_id,
          };

          if (index === lastIndex) {
            jobOptions.last_in_sequence = true;
          }

          serverJobs.createJob(jobOptions, (err, job) => {
            if (err) {
              logger.error('Error in createJob()', err);
              return callback(err);
            }
            debug('successfully created job ', { job_sequence_id });

            // continue executing here to launch the actual job
            pullAndPushToECR(image.image, auth, job, (err) => {
              if (err) {
                job.fail(error.newMessage(err, `Error syncing ${image.image}`));
                return callback(err);
              }

              job.succeed();
              callback(null);
            });
          });
        },
        (err) => {
          if (err) {
            serverJobs.failJobSequence(job_sequence_id);
          }
        }
      );
    });
  });
};