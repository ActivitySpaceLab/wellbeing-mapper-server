const app = require('./server');

// AWS Lambda handler for Function URLs and API Gateway.
exports.handler = async (event, context) => {
  const isWebEvent = event.httpMethod
    || (event.requestContext && (event.requestContext.httpMethod || event.requestContext.http));

  if (isWebEvent) {
    const serverless = require('serverless-http');
    const handler = serverless(app);
    return handler(event, context);
  }

  // Direct invocation (e.g. CloudWatch health checks).
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: 'healthy',
      message: 'Wellbeing Mapper data collection server (Lambda)',
      timestamp: new Date().toISOString(),
    }),
  };
};
