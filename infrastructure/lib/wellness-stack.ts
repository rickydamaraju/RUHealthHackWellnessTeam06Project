import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

interface Props extends StackProps { stage: string; bedrockModelId?: string; modelEndpointName?: string; createCognitoDomain?: boolean }

export class WellnessStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    Tags.of(this).add('Project', 'GlucoseCompass');
    Tags.of(this).add('Stage', props.stage);
    const repo = path.resolve(__dirname, '../..');
    const commonBucket = { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, removalPolicy: RemovalPolicy.RETAIN };
    const website = new s3.Bucket(this, 'Website', commonBucket);
    const origin = origins.S3BucketOrigin.withOriginAccessControl(website);
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultRootObject: 'index.html', minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: { origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS },
      additionalBehaviors: { 'config.json': { origin, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS } },
      errorResponses: [403, 404].map(httpStatus => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) })),
    });
    const websiteUrl = `https://${distribution.distributionDomainName}`;
    const allowedOrigins = [websiteUrl, ...(props.stage === 'dev' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [])];
    const files = new s3.Bucket(this, 'UserFiles', {
      ...commonBucket, versioned: true,
      cors: [{ allowedOrigins, allowedMethods: [s3.HttpMethods.POST], allowedHeaders: ['*'], maxAge: 300 }],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });
    const models = new s3.Bucket(this, 'Models', { ...commonBucket, versioned: true });
    const records = new dynamodb.Table(this, 'Records', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: RemovalPolicy.RETAIN,
    });
    const users = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: true, signInAliases: { email: true }, autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      removalPolicy: RemovalPolicy.RETAIN, deletionProtection: true,
    });
    const accessScope = new cognito.ResourceServerScope({ scopeName: 'access', scopeDescription: 'Access your wellness records' });
    const resourceServer = users.addResourceServer('ApiResource', { identifier: 'wellness-api', scopes: [accessScope] });
    const client = users.addClient('WebClient', {
      generateSecret: false, preventUserExistenceErrors: true, enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(30), idTokenValidity: Duration.minutes(30), refreshTokenValidity: Duration.days(7),
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE, cognito.OAuthScope.resourceServer(resourceServer, accessScope)],
        callbackUrls: allowedOrigins.map(url => `${url}/auth/callback`), logoutUrls: allowedOrigins.map(url => `${url}/`) },
    });
    const domain = props.createCognitoDomain === false ? undefined : users.addDomain('Domain', { cognitoDomain: { domainPrefix: `glucose-compass-${this.account}-${this.region}-${props.stage}` } });
    const guardrail = new bedrock.CfnGuardrail(this, 'WellnessGuardrail', {
      name: `glucose-compass-wellness-${props.stage}`, blockedInputMessaging: 'Please describe a meal.', blockedOutputsMessaging: 'An explanation is unavailable.',
      topicPolicyConfig: { topicsConfig: [
        { name: 'Diagnosis', type: 'DENY', definition: 'Claims that a person has or does not have a medical condition based on glucose readings or predictions.', examples: ['This glucose prediction proves you have diabetes.'] },
        { name: 'MedicationDosing', type: 'DENY', definition: 'Instructions to start, stop, increase, decrease, or time a medication dose based on an individual glucose prediction.', examples: ['Increase your insulin dose before this meal.'] },
      ] },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'WellnessGuardrailVersion', { guardrailIdentifier: guardrail.attrGuardrailId, description: 'Initial wellness wording policy' });
    const backendCode = lambda.DockerImageCode.fromImageAsset(path.join(repo, 'backend'), { platform: ecrAssets.Platform.LINUX_AMD64 });
    const environment = { TABLE_NAME: records.tableName, DATA_BUCKET: files.bucketName, MODELS_BUCKET: models.bucketName, BEDROCK_MODEL_ID: props.bedrockModelId ?? '', MODEL_ENDPOINT_NAME: props.modelEndpointName ?? '', GUARDRAIL_ID: guardrail.attrGuardrailId, GUARDRAIL_VERSION: guardrailVersion.attrVersion };
    const apiFunction = new lambda.DockerImageFunction(this, 'ApiFunction', {
      code: backendCode, memorySize: 1024, timeout: Duration.seconds(25), environment,
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
    });
    records.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [files.arnForObjects('users/*')] }));
    apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [files.arnForObjects('users/*')] }));
    models.grantRead(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }));
    if (props.bedrockModelId) apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${props.bedrockModelId}`] }));
    if (props.modelEndpointName) apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['sagemaker:InvokeEndpoint'], resources: [`arn:${this.partition}:sagemaker:${this.region}:${this.account}:endpoint/${props.modelEndpointName}`] }));
    const authorizer = new HttpJwtAuthorizer('CognitoAuthorizer', users.userPoolProviderUrl, { jwtAudience: [client.userPoolClientId] });
    const api = new apigw.HttpApi(this, 'Api', {
      defaultAuthorizer: authorizer, defaultAuthorizationScopes: ['wellness-api/access'],
      corsPreflight: { allowOrigins: allowedOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS], maxAge: Duration.hours(1) },
    });
    const integration = new HttpLambdaIntegration('Backend', apiFunction);
    api.addRoutes({ path: '/{proxy+}', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration });
    api.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration, authorizer: new apigw.HttpNoneAuthorizer(), authorizationScopes: [] });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };
    const deadLetterQueue = new sqs.Queue(this, 'ImportDLQ', { retentionPeriod: Duration.days(14), enforceSSL: true });
    const imports = new sqs.Queue(this, 'ImportQueue', { visibilityTimeout: Duration.minutes(12), enforceSSL: true, deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 } });
    files.addEventNotification(s3.EventType.OBJECT_CREATED, new SqsDestination(imports), { prefix: 'users/', suffix: '.csv' });
    files.addEventNotification(s3.EventType.OBJECT_CREATED, new SqsDestination(imports), { prefix: 'users/', suffix: '.zip' });
    const worker = new lambda.DockerImageFunction(this, 'ImportWorker', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(repo, 'backend'), { platform: ecrAssets.Platform.LINUX_AMD64, cmd: ['app.import_worker.handler'] }),
      memorySize: 1024, timeout: Duration.minutes(2), environment: { TABLE_NAME: records.tableName, DATA_BUCKET: files.bucketName },
      logGroup: new logs.LogGroup(this, 'ImportLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
    });
    records.grantReadWriteData(worker);
    files.grantRead(worker, 'users/*');
    files.grantPut(worker, 'prepared/*');
    worker.addEventSource(new SqsEventSource(imports, { batchSize: 1, reportBatchItemFailures: true }));
    new cloudwatch.Alarm(this, 'FailedImports', { metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'A CGM import exhausted retries. Inspect the DLQ without exposing user data.' });
    new deployment.BucketDeployment(this, 'PublishWebsite', {
      destinationBucket: website, distribution, distributionPaths: ['/*'],
      sources: [deployment.Source.asset(path.join(repo, 'frontend/dist')), deployment.Source.jsonData('config.json', {
        apiUrl: api.apiEndpoint, region: this.region, userPoolId: users.userPoolId, clientId: client.userPoolClientId,
        cognitoDomain: domain?.baseUrl() ?? '', configured: Boolean(domain),
      })],
    });
    new deployment.BucketDeployment(this, 'PublishCatalog', { destinationBucket: files, destinationKeyPrefix: 'catalog/v1', sources: [deployment.Source.asset(path.join(repo, 'backend/app/data'))], prune: false });
    new CfnOutput(this, 'WebsiteUrl', { value: websiteUrl });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId });
    new CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'DataBucket', { value: files.bucketName });
    new CfnOutput(this, 'ModelBucket', { value: models.bucketName });
  }
}
