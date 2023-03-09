const core = require("@actions/core");
const AWS = require("aws-sdk");
const fs = require('fs');

const ecs = new AWS.ECS();

async function registerTaskDefinition(filePath) {
  const taskDefinitionStr = fs.readFileSync(filePath, 'utf8');
  const taskDefinition = JSON.parse(taskDefinitionStr);


  let registerResponse;
  try {
    registerResponse = await ecs.registerTaskDefinition(taskDefinition).promise();
  } catch (error) {
    core.setFailed("Failed to register task definition in ECS: " + error.message);
    core.debug("Task definition contents:");
    core.debug(JSON.stringify(taskDefinition, undefined, 4));
    throw(error);
  }
  const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
  core.setOutput('task-definition-arn', taskDefArn);

  return taskDefArn
}

async function fetchNetworkConfiguration(cluster, service) {
  try {
    // Get network configuration from aws directly from describe services
    core.debug("Getting information from service...");
    const info = await ecs.describeServices({ cluster, services: [service] }).promise();

    if (!info || !info.services[0]) {
      throw new Error(`Could not find service ${service} in cluster ${cluster}`);
    }

    if (!info.services[0].networkConfiguration) {
      throw new Error(`Service ${service} in cluster ${cluster} does not have a network configuration`);
    }

    return info.services[0].networkConfiguration;
  } catch (error) {
    core.setFailed(error.message);
    throw(error)
  }
}

const WAIT_DEFAULT_DELAY_SEC = 5;
const MAX_WAIT_MINUTES = 60;

async function waitForTasksStopped(clusterName, taskArns, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;

  core.debug('Waiting for tasks to stop');

  const waitTaskResponse = await ecs.waitFor('tasksStopped', {
    cluster: clusterName,
    tasks: taskArns,
    $waiter: {
      delay: WAIT_DEFAULT_DELAY_SEC,
      maxAttempts
    }
  }).promise();

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`)
  core.info('All tasks have stopped.');
}

async function tasksExitCode(clusterName, taskArns) {
  core.debug(`Checking status of ${clusterName} tasks ${taskArns.join(', ')}`);
  const describeResponse = await ecs.describeTasks({
    cluster: clusterName,
    tasks: taskArns
  }).promise();

  const containers = [].concat(...describeResponse.tasks.map(task => task.containers))
  const exitCodes = containers.map(container => container.exitCode)
  const reasons = containers.map(container => container.reason)

  const failuresIdx = [];

  exitCodes.filter((exitCode, index) => {
    if (exitCode !== 0) {
      failuresIdx.push(index)
    }
  })

  const failures = reasons.filter((_, index) => failuresIdx.indexOf(index) !== -1)

  if (failures.length > 0) {
    core.setFailed(failures.join("\n"));
  } else {
    core.info(`All tasks have exited successfully.`);
  }
}

const main = async () => {

  const waitForFinish = (core.getInput('wait-for-finish', { required: false }) || 'true').toLowerCase() === 'true';
  const cluster = core.getInput("cluster", { required: true });
  const service = core.getInput('service', { required: true });
  const taskDefinitionPath = core.getInput("task-definition", { required: true });
  const waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 10;

  const taskDefinition = await registerTaskDefinition(taskDefinitionPath);
  const networkConfiguration = await fetchNetworkConfiguration(cluster, service);

  const overrideContainer = core.getInput("override-container", {
    required: false,
  });
  const overrideContainerCommand = core.getMultilineInput(
      "override-container-command",
      {
        required: false,
      }
  );

  const taskParams = {
    taskDefinition,
    cluster,
    count: 1,
    launchType: "FARGATE",
    networkConfiguration,
  };

  try {
    if (overrideContainerCommand.length > 0 && !overrideContainer) {
      throw new Error(
          "override-container is required when override-container-command is set"
      );
    }

    if (overrideContainer) {
      if (overrideContainerCommand) {
        taskParams.overrides = {
          containerOverrides: [
              {
                name: overrideContainer,
                command: overrideContainerCommand,
              },
          ],
        };
      } else {
        throw new Error(
            "override-container-command is required when override-container is set"
        );
      }
    }

    core.debug("Running task...");
    let task = await ecs.runTask(taskParams).promise();
    const taskArn = task.tasks[0].taskArn;
    core.setOutput("task-arn", taskArn);

    if (waitForFinish) {
      await waitForTasksStopped(cluster, [taskArn], waitForMinutes);
      await tasksExitCode(cluster, [taskArn])
    }
  } catch (error) {
    core.setFailed(error.message);
  }
};

main();
