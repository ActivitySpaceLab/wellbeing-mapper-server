#!/bin/bash

# AWS Lambda Deployment Script for Wellbeing Mapper Data Collection Server
# Deploys to AWS Cape Town (af-south-1) region for data sovereignty

set -e

# Configuration
AWS_REGION="af-south-1"
FUNCTION_NAME="wellbeing-mapper-data-collection"
RUNTIME="nodejs18.x"
TIMEOUT=30
MEMORY_SIZE=256

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Deploying Wellbeing Mapper Data Collection Server to AWS Lambda (Cape Town)${NC}"
echo "============================================================="

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first.${NC}"
    echo "   Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
    exit 1
fi

# Check if jq is installed (for JSON parsing)
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq is not installed. Some features may not work.${NC}"
    echo "   Install: brew install jq (macOS) or apt-get install jq (Ubuntu)"
fi

# Verify AWS credentials
echo -e "${BLUE}🔐 Checking AWS credentials...${NC}"
if ! aws sts get-caller-identity --region $AWS_REGION &> /dev/null; then
    echo -e "${RED}❌ AWS credentials not configured or invalid.${NC}"
    echo "   Run: aws configure"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region $AWS_REGION)
echo -e "${GREEN}✅ AWS credentials valid (Account: $ACCOUNT_ID)${NC}"

# Create deployment package
echo -e "${BLUE}📦 Creating deployment package...${NC}"
cd "$(dirname "$0")/.."

# Clean previous builds
rm -rf dist
rm -f deploy/server.zip

# Create distribution directory
mkdir -p dist

# Copy source files
cp server.js dist/
cp package.json dist/
cp participant_codes.json dist/

# Install production dependencies
echo -e "${BLUE}📥 Installing production dependencies...${NC}"
cd dist
npm install --production --silent
cd ..

# Create Lambda-compatible handler
cp lambda-handler.js dist/index.js

# Add serverless-http dependency
cd dist
npm install serverless-http --silent
cd ..

# Create deployment ZIP
echo -e "${BLUE}🗜️  Creating deployment ZIP...${NC}"
cd dist
zip -r ../deploy/server.zip . -q
cd ..

ZIP_SIZE=$(du -h deploy/server.zip | cut -f1)
echo -e "${GREEN}✅ Deployment package created: $ZIP_SIZE${NC}"

# Check if Lambda function exists
echo -e "${BLUE}🔍 Checking if Lambda function exists...${NC}"
if aws lambda get-function --function-name $FUNCTION_NAME --region $AWS_REGION &> /dev/null; then
    echo -e "${YELLOW}📝 Function exists. Updating code...${NC}"
    
    # Update function code
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://deploy/server.zip \
        --region $AWS_REGION \
        --no-cli-pager
        
    echo -e "${GREEN}✅ Function code updated${NC}"
else
    echo -e "${YELLOW}🆕 Function doesn't exist. Creating new function...${NC}"
    
    # Create IAM role if it doesn't exist
    ROLE_NAME="lambda-execution-role-wellbeing"
    ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"
    
    if ! aws iam get-role --role-name $ROLE_NAME --region $AWS_REGION &> /dev/null; then
        echo -e "${BLUE}🛠️  Creating IAM role...${NC}"
        
        # Create trust policy
        cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
        
        aws iam create-role \
            --role-name $ROLE_NAME \
            --assume-role-policy-document file://trust-policy.json \
            --region $AWS_REGION
            
        # Attach basic execution policy
        aws iam attach-role-policy \
            --role-name $ROLE_NAME \
            --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
            --region $AWS_REGION
            
        rm trust-policy.json
        echo -e "${GREEN}✅ IAM role created${NC}"
        
        # Wait for role to be available
        echo -e "${BLUE}⏳ Waiting for IAM role to be available...${NC}"
        sleep 10
    fi
    
    # Create Lambda function
    aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime $RUNTIME \
        --role $ROLE_ARN \
        --handler index.handler \
        --zip-file fileb://deploy/server.zip \
        --timeout $TIMEOUT \
        --memory-size $MEMORY_SIZE \
        --region $AWS_REGION \
        --environment Variables='{NODE_ENV=production,ALLOWED_ORIGINS=*}' \
        --no-cli-pager
        
    echo -e "${GREEN}✅ Lambda function created${NC}"
fi

# Get function info
echo -e "${BLUE}📋 Getting function information...${NC}"
FUNCTION_INFO=$(aws lambda get-function --function-name $FUNCTION_NAME --region $AWS_REGION)

if command -v jq &> /dev/null; then
    FUNCTION_ARN=$(echo $FUNCTION_INFO | jq -r '.Configuration.FunctionArn')
    LAST_MODIFIED=$(echo $FUNCTION_INFO | jq -r '.Configuration.LastModified')
    echo -e "${GREEN}✅ Function ARN: $FUNCTION_ARN${NC}"
    echo -e "${GREEN}✅ Last Modified: $LAST_MODIFIED${NC}"
fi

# Create API Gateway (optional)
echo -e "${BLUE}🌐 Setting up API Gateway...${NC}"
API_NAME="wellbeing-mapper-data-collection-api"

# Check if API exists
API_ID=$(aws apigateway get-rest-apis --region $AWS_REGION --query "items[?name=='$API_NAME'].id" --output text)

if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
    echo -e "${YELLOW}🆕 Creating API Gateway...${NC}"
    
    # Create API
    API_ID=$(aws apigateway create-rest-api \
        --name $API_NAME \
        --description "API for Wellbeing Mapper Data Collection Server" \
        --region $AWS_REGION \
        --query 'id' \
        --output text)
        
    # Get root resource ID
    ROOT_ID=$(aws apigateway get-resources \
        --rest-api-id $API_ID \
        --region $AWS_REGION \
        --query 'items[?path==`/`].id' \
        --output text)
        
    # Create proxy resource
    RESOURCE_ID=$(aws apigateway create-resource \
        --rest-api-id $API_ID \
        --parent-id $ROOT_ID \
        --path-part '{proxy+}' \
        --region $AWS_REGION \
        --query 'id' \
        --output text)
        
    # Create ANY method
    aws apigateway put-method \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method ANY \
        --authorization-type NONE \
        --region $AWS_REGION \
        --no-cli-pager
        
    # Set up Lambda integration
    aws apigateway put-integration \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method ANY \
        --type AWS_PROXY \
        --integration-http-method POST \
        --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:function:$FUNCTION_NAME/invocations" \
        --region $AWS_REGION \
        --no-cli-pager
        
    # Grant API Gateway permission to invoke Lambda
    aws lambda add-permission \
        --function-name $FUNCTION_NAME \
        --statement-id api-gateway-invoke \
        --action lambda:InvokeFunction \
        --principal apigateway.amazonaws.com \
        --source-arn "arn:aws:execute-api:$AWS_REGION:$ACCOUNT_ID:$API_ID/*/*" \
        --region $AWS_REGION \
        --no-cli-pager
        
    # Deploy API
    aws apigateway create-deployment \
        --rest-api-id $API_ID \
        --stage-name prod \
        --region $AWS_REGION \
        --no-cli-pager
        
    echo -e "${GREEN}✅ API Gateway created${NC}"
else
    echo -e "${GREEN}✅ API Gateway already exists (ID: $API_ID)${NC}"
fi

# Get API URL
API_URL="https://$API_ID.execute-api.$AWS_REGION.amazonaws.com/prod"

echo ""
echo "============================================================="
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo "============================================================="
echo -e "${BLUE}📍 Region:${NC} $AWS_REGION (Cape Town)"
echo -e "${BLUE}🔗 API URL:${NC} $API_URL"
echo -e "${BLUE}📋 Function Name:${NC} $FUNCTION_NAME"
echo -e "${BLUE}🆔 Account ID:${NC} $ACCOUNT_ID"
echo ""
echo -e "${BLUE}🧪 Test Commands:${NC}"
echo "   Health Check: curl $API_URL/health"
echo "   Test Suite:   node test/test-server.js $API_URL"
echo ""
echo -e "${BLUE}🛠️  Management Commands:${NC}"
echo "   View Logs:    aws logs tail /aws/lambda/$FUNCTION_NAME --region $AWS_REGION --follow"
echo "   Update Code:  ./deploy.sh"
echo "   Delete Stack: aws lambda delete-function --function-name $FUNCTION_NAME --region $AWS_REGION"
echo ""

# Clean up
rm -rf dist

echo -e "${GREEN}✅ Deployment script completed successfully!${NC}"