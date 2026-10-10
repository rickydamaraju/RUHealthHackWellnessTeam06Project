import { App } from 'aws-cdk-lib';
import { WellnessStack } from '../lib/wellness-stack';
import { DeploymentStack } from '../lib/deployment-stack';

const app = new App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(stage)) throw new Error('stage must be a short lowercase name');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
new WellnessStack(app, `Sathi-${stage}`, {
  env, stage,
  bedrockModelId: app.node.tryGetContext('bedrockModelId'),
  modelEndpointName: app.node.tryGetContext('modelEndpointName'),
});
const connectionArn = app.node.tryGetContext('connectionArn');
if (connectionArn) new DeploymentStack(app, `SathiPipeline-${stage}`, { env, stage, connectionArn });
