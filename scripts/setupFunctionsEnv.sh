#!/bin/bash

# Script to set up Firebase Functions environment variables
# Run this from the project root: bash scripts/setupFunctionsEnv.sh

echo "🔧 Setting up Firebase Functions Environment Variables"
echo "======================================================="
echo ""
echo "This script will help you set up environment variables for your Firebase Functions."
echo ""
echo "You'll need:"
echo "  - OpenAI API key from: https://platform.openai.com/api-keys"
echo "  - Stripe API keys from: https://dashboard.stripe.com/apikeys"
echo ""

# Function to set a secret
set_secret() {
  local name=$1
  local description=$2
  
  echo ""
  echo "📝 Setting: $name"
  echo "   ($description)"
  read -p "Enter value for $name: " value
  
  if [ -z "$value" ]; then
    echo "⚠️  Skipping $name (no value provided)"
  else
    echo "$value" | firebase functions:secrets:set "$name"
    if [ $? -eq 0 ]; then
      echo "✅ $name set successfully"
    else
      echo "❌ Failed to set $name"
    fi
  fi
}

# Check if logged into Firebase
echo "Checking Firebase authentication..."
firebase projects:list > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "❌ Not logged into Firebase. Please run: firebase login"
  exit 1
fi

echo "✅ Firebase authentication confirmed"
echo ""

# Set required secrets
echo "🔐 Setting Required Secrets"
echo "============================"

set_secret "OPENAI_API_KEY" "OpenAI API Key (starts with sk-proj- or sk-)"
set_secret "STRIPE_SECRET_KEY" "Stripe Secret Key (starts with sk_test_ or sk_live_)"
set_secret "STRIPE_WEBHOOK_SECRET" "Stripe Webhook Secret (starts with whsec_)"
set_secret "STRIPE_LIFETIME_PRICE_ID" "Stripe Lifetime Price ID (starts with price_)"
set_secret "STRIPE_MONTHLY_PRICE_ID" "Stripe Monthly Price ID (starts with price_)"

# Set optional config (using Firebase config, not secrets)
echo ""
echo "⚙️  Optional Configuration"
echo "========================="
echo ""
echo "Setting optional configuration values..."

read -p "Lifetime user limit (default: 15): " lifetime_limit
lifetime_limit=${lifetime_limit:-15}
firebase functions:config:set payment.lifetime_user_limit="$lifetime_limit"

read -p "Lifetime price amount in cents (default: 4900 = $49): " lifetime_amount
lifetime_amount=${lifetime_amount:-4900}
firebase functions:config:set payment.lifetime_price_amount="$lifetime_amount"

read -p "Monthly price amount in cents (default: 900 = $9): " monthly_amount
monthly_amount=${monthly_amount:-900}
firebase functions:config:set payment.monthly_price_amount="$monthly_amount"

read -p "App base URL (default: https://collabcanvas-2a674.web.app): " app_url
app_url=${app_url:-https://collabcanvas-2a674.web.app}
firebase functions:config:set app.base_url="$app_url"

echo ""
echo "✅ Configuration complete!"
echo ""
echo "📋 Next Steps:"
echo "1. Deploy your functions: firebase deploy --only functions"
echo "2. Get your webhook URL from the deployed function"
echo "3. Add the webhook URL to your Stripe Dashboard"
echo ""
echo "To view your current configuration:"
echo "  firebase functions:config:get"
echo "  firebase functions:secrets:access OPENAI_API_KEY"
echo "  firebase functions:secrets:access STRIPE_SECRET_KEY"

