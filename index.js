const core = require("@actions/core");
const {
  ECSClient,
  RegisterTaskDefinitionCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  RunTaskCommand,
  waitUntilTasksStopped
} = require("@aws-sdk/client-ecs");
const fs = require('fs');

const client = new ECSClient({});

async function registerTaskDefinition(filePath) {
  const taskDefinitionStr = fs.readFileSync(filePath, 'utf8');
  const taskDefinition = JSON.parse(taskDefinitionStr);


  let registerResponse;
  try {
    registerResponse = await client.send(new RegisterTaskDefinitionCommand(taskDefinition));
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

async function fetchTaskDefinitionArn(taskDefinition) {
  try {
    core.debug(`Getting ${taskDefinition}'s latest task definition.`)
    const response = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition }))
    if (!response || !response.taskDefinition) throw new Error(`${taskDefinition} not found.`)
      const taskDefArn = response.taskDefinition.taskDefinitionArn;
      core.setOutput('task-definition-arn', taskDefArn);
      return taskDefArn
  } catch (error) {
    core.setFailed(error.message)
    throw(error)
  }
}

async function fetchNetworkConfiguration(cluster, service) {
  try {
    // Get network configuration from aws directly from describe services
    core.debug("Getting information from service...");
    const info = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));

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

const MAX_WAIT_MINUTES = 60;

async function waitForTasksStopped(clusterName, taskArn, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) waitForMinutes = MAX_WAIT_MINUTES;

  core.debug(`Waiting ${waitForMinutes} minutes for task to stop.`);

  await waitUntilTasksStopped({
    client,
    maxWaitTime: waitForMinutes * 60,
    minDelay: 5,
    maxDelay: 10
  }, {
    cluster: clusterName,
    tasks: [taskArn],
  });

  core.info('All task has stopped.');
}

async function tasksExitCode(clusterName, taskArn) {
  core.debug(`Checking status of ${clusterName} task: ${taskArn}`);
  const describeResponse = await client.send(new DescribeTasksCommand({
    cluster: clusterName,
    tasks: [taskArn]
  }));

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
  const taskDefinitionPath = core.getInput("task-definition", { required: false });
  const taskDefinitionFamily = core.getInput("task-definition-family", {required: false })
  if (!taskDefinitionPath && !taskDefinitionFamily) {
    core.setFailed('task-definition-family or task-definition are required.');
    return
  }
  const waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 10;
  let taskDefinitionArn;
  if (!taskDefinitionFamily) {
    taskDefinitionArn = await registerTaskDefinition(taskDefinitionPath);
  } else {
    taskDefinitionArn = await fetchTaskDefinitionArn(taskDefinitionFamily)
  }

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
    taskDefinition: taskDefinitionArn,
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
    let task = await client.send(new RunTaskCommand(taskParams));
    const taskArn = task.tasks[0].taskArn;
    core.setOutput("task-arn", taskArn);

    const taskIdentity = taskArn.split("/").pop();
    core.notice(`Task started. Watch this task's progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${await client.config.region()}#/clusters/${cluster}/tasks/${taskIdentity}/details`);

    if (waitForFinish) {
      await waitForTasksStopped(cluster, taskArn, waitForMinutes);
      await tasksExitCode(cluster, taskArn)
    }
  } catch (error) {
    core.setFailed(error.message);
  }
};

main();
