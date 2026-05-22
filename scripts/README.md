# Firebase Utility Scripts

This directory contains utility scripts for managing your Firebase project.

## Scripts Available

1. **Environment Setup** (`setupFunctionsEnv.sh`) - Set up Cloud Functions environment variables
2. **Data Clearing** (`clearFirebaseData.cjs`) - Clear all Firebase data (destructive)
3. **Auth User Deletion** (`deleteAllAuthUsers.cjs`) - Delete all Firebase Auth users

---

## 1. Environment Setup Script

**Purpose**: Configure environment variables for Firebase Cloud Functions (Stripe integration).

See detailed guide: [`functions/ENV_SETUP.md`](../functions/ENV_SETUP.md)

### Quick Start

```bash
# Run from project root
bash scripts/setupFunctionsEnv.sh
```

This interactive script will help you set up:
- Stripe API keys (Secret Key, Webhook Secret)
- Stripe Price IDs (Lifetime and Monthly)
- Payment configuration (limits, amounts)
- App configuration (base URL)

---

## 2. Firebase Data Clearing Script

**Purpose**: Completely clear your Firebase project data, including Auth users and Firestore collections.

## ⚠️ WARNING

**This script is EXTREMELY DESTRUCTIVE and should ONLY be used in development/testing environments!**

It will permanently delete:
- All Firebase Auth users
- All documents in the `users` collection
- All documents in the `userPreferences` collection
- All documents in the `canvases` collection (except the "main" canvas, includes metadata and subcollections)

## Prerequisites

1. **Firebase Service Account Key**: These scripts require a Firebase service account key to authenticate with the Firebase Admin SDK when running locally.

   ### Setup Instructions:
   
   1. **Download your service account key:**
      - Go to [Firebase Console](https://console.firebase.google.com/)
      - Select your project
      - Navigate to **Project Settings** (gear icon) > **Service Accounts**
      - Click **Generate New Private Key**
      - Save the downloaded JSON file securely (e.g., `~/firebase-keys/collabcanvas-key.json`)
      - ⚠️ **Keep this file secure!** It grants admin access to your Firebase project
   
   2. **Set the environment variable:**
      ```bash
      export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
      ```
      
      Or add it to your shell profile (~/.zshrc, ~/.bashrc, etc.) to persist:
      ```bash
      echo 'export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"' >> ~/.zshrc
      source ~/.zshrc
      ```

2. **Dependencies**: The script uses `firebase-admin` which is already installed in the `functions` directory.

## Usage

### Method 1: Using npm script (Recommended)
```bash
# Make sure GOOGLE_APPLICATION_CREDENTIALS is set first
npm run clear-firebase
```

### Method 2: Direct execution
```bash
node scripts/clearFirebaseData.cjs
```

### Method 3: One-time execution with inline credentials
```bash
GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json" node scripts/clearFirebaseData.cjs
```

For the `deleteAllAuthUsers.cjs` script (deletes only Auth users):
```bash
node scripts/deleteAllAuthUsers.cjs
# or
GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json" node scripts/deleteAllAuthUsers.cjs
```

## How it Works

1. The script will display a warning message showing what will be deleted
2. You must type `DELETE ALL` (exactly) to confirm the operation
3. The script will then:
   - Delete all Firebase Auth users in batches of 1000
   - Delete all documents from specified Firestore collections in batches of 500
   - Skip the "main" canvas document
   - Delete any subcollections found

## Safety Features

- **Confirmation prompt**: You must type `DELETE ALL` to proceed
- **Preserves "main" canvas**: The main canvas document is always preserved
- **Batch processing**: Uses batched operations to handle large datasets
- **Error handling**: Stops on errors and reports the issue

## Example Output

```
🔥 FIREBASE DATA CLEARING SCRIPT 🔥
====================================

⚠️  WARNING: This will delete:
   - All Firebase Auth users
   - All documents in: users
   - All documents in: userPreferences
   - All canvases EXCEPT "main" (includes metadata and subcollections)

⚠️  This operation is IRREVERSIBLE!

Type "DELETE ALL" to confirm: DELETE ALL

🚀 Starting data deletion...

📋 Fetching all Auth users...
   Deleting 25 users...
✅ Deleted 25 Auth users

📋 Deleting collection: users
   Deleted batch of 25 documents (total: 25)
✅ Deleted 25 documents

...

✅ ✅ ✅ ALL DATA CLEARED SUCCESSFULLY! ✅ ✅ ✅
```

## Troubleshooting

### "getaddrinfo ENOTFOUND metadata.google.internal" error
- This means the GOOGLE_APPLICATION_CREDENTIALS environment variable is not set
- Follow the setup instructions above to download and configure your service account key

### "Permission denied" error
- Make sure GOOGLE_APPLICATION_CREDENTIALS points to a valid service account key
- Verify the service account has admin access to the Firebase project
- Check that the key file hasn't been revoked in the Firebase Console

### "Module not found" error
- Make sure `firebase-admin` is installed: `cd functions && npm install`
- Or ensure you use the npm script: `npm run clear-firebase`

### Script hangs
- The script processes data in batches, which can take time for large datasets
- Be patient and wait for completion
- Check your network connection

## Notes

- The script uses the project ID from `.firebaserc` (collabcanvas-2a674)
- Batch size is limited to 500 documents per batch for Firestore operations
- Auth users are deleted in batches of 1000
- The script will exit with code 0 on success, 1 on error

# my notes
use a Service Account Key file .
Generate a Service Account Key:
Go to your Firebase project in the Firebase Console.
Navigate to Project settings (the gear icon) > Service accounts .
Click on Generate new private key and then Generate key . This will download a JSON file to your computer. Keep this file secure; it grants administrative access to your Firebase project.
Initialize the Admin SDK with the Key: You have two main ways to use this key in your script:
Option A (Recommended for local development): Use GOOGLE_APPLICATION_CREDENTIALS environment variable. Set an environment variable named GOOGLE_APPLICATION_CREDENTIALS to the file path of the JSON key you just downloaded.
Then, your initializeApp() call will automatically pick it up:
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'collabcanvas-2a674'
    // No need to explicitly provide 'credential' here if GOOGLE_APPLICATION_CREDENTIALS is set
  });
}
This is often preferred because it keeps your sensitive key path out of your code.


GOOGLE_APPLICATION_CREDENTIALS="/Users/bdr/firebase-adminsdk-pkey.json" node ../scripts/deleteAllAuthUsers.cjs


You need to grant the Service Usage Consumer role to the service account that corresponds to your firebase-adminsdk-pkey.json file.
Identify the Service Account:
Open your firebase-adminsdk-pkey.json file in a text editor.
Look for a field like "client_email" . This email address (e.g., firebase-adminsdk-xxxx@collabcanvas-2a674.iam.gserviceaccount.com ) is the identity of your service account. Copy this email.
Go to IAM & Admin in Google Cloud Console:
Open the Google Cloud Console  for your project collabcanvas-2a674 .
In the navigation menu, go to IAM & Admin > IAM .
Add the Role:
Click on the "+GRANT ACCESS" button at the top.
In the "New principals" field, paste the client_email of your service account.
Click on "Select a role". Search for Service Usage Consumer (role ID roles/serviceusage.serviceUsageConsumer ) and select it.
Click "SAVE" .
After granting this role, it might take a few minutes for the changes to propagate, but then you should be able to run your script without this particular permission error.