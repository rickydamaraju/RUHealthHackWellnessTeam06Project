import { App } from 'aws-cdk-lib';
import { WellnessStack } from '../lib/wellness-stack';
import { DeploymentStack } from '../lib/deployment-stack';

const app = new App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(stage)) throw new Error('stage must be a short lowercase name');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
const deployedStackName: string | undefined = app.node.tryGetContext('deployedStackName');
new WellnessStack(app, deployedStackName ?? `GlucoseCompass-${stage}`, {
  env, stage, stackName: deployedStackName,
  bedrockModelId: app.node.tryGetContext('bedrockModelId'),
  modelEndpointName: app.node.tryGetContext('modelEndpointName'),
  createCognitoDomain: app.node.tryGetContext('skipCognitoDomain') !== 'true',
});
const connectionArn = app.node.tryGetContext('connectionArn');
if (connectionArn) new DeploymentStack(app, `GlucoseCompassPipeline-${stage}`, { env, stage, connectionArn });
