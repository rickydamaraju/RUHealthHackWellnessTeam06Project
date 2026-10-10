import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';

interface Props extends StackProps { stage: string; connectionArn: string }
export class DeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const source = new codepipeline.Artifact();
    const project = new codebuild.PipelineProject(this, 'BuildAndDeploy', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, privileged: true },
      buildSpec: codebuild.BuildSpec.fromObject({ version: '0.2', phases: {
        install: { 'runtime-versions': { nodejs: 22, python: '3.12' }, commands: ['npm ci', 'python -m pip install -r backend/requirements-dev.txt'] },
        pre_build: { commands: ['npm run check', 'PYTHONPATH=backend python -m pytest backend/tests -q', 'npm run build'] },
        build: { commands: [`npx cdk deploy Sathi-${props.stage} --app 'npx tsx infrastructure/bin/app.ts' -c stage=${props.stage} --require-approval never`] },
      } }),
    });
    project.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`] }));
    project.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [`arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`, `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/Sathi-${props.stage}/*`] }));
    project.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`] }));
    new codepipeline.Pipeline(this, 'Pipeline', { pipelineType: codepipeline.PipelineType.V2, stages: [
      { stageName: 'Source', actions: [new actions.CodeStarConnectionsSourceAction({ actionName: 'GitHub', owner: 'rickydamaraju', repo: 'RUHealthHackWellnessTeam06Project', branch: 'main', connectionArn: props.connectionArn, output: source })] },
      { stageName: 'BuildAndDeploy', actions: [new actions.CodeBuildAction({ actionName: 'ValidateAndDeploy', project, input: source })] },
    ] });
  }
}
