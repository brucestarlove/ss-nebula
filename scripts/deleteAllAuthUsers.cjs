#!/usr/bin/env node

/**
 * Delete all Firebase Auth users
 * 
 * Setup:
 * 1. Download your Firebase service account key from:
 *    Firebase Console > Project Settings > Service Accounts > Generate New Private Key
 * 2. Set the GOOGLE_APPLICATION_CREDENTIALS environment variable:
 *    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 * 
 * Usage: 
 *    node scripts/deleteAllAuthUsers.cjs
 * 
 * Or in one line:
 *    GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json" node scripts/deleteAllAuthUsers.cjs
 */

const admin = require('../functions/node_modules/firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'collabcanvas-2a674'
  });
}

const auth = admin.auth();

async function deleteAllAuthUsers() {
  console.log('\n🔥 Deleting all Firebase Auth users...\n');
  
  let totalDeleted = 0;
  let nextPageToken;
  
  do {
    const listUsersResult = await auth.listUsers(1000, nextPageToken);
    const uids = listUsersResult.users.map(user => user.uid);
    
    if (uids.length === 0) break;
    
    console.log(`Deleting ${uids.length} users...`);
    await auth.deleteUsers(uids);
    totalDeleted += uids.length;
    
    nextPageToken = listUsersResult.pageToken;
  } while (nextPageToken);
  
  console.log(`\n✅ Deleted ${totalDeleted} users\n`);
}

deleteAllAuthUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ Error:', err.message || err);
    console.error('\n💡 Tip: Make sure GOOGLE_APPLICATION_CREDENTIALS is set to your service account key path.');
    console.error('   See the comments at the top of this file for setup instructions.\n');
    process.exit(1);
  });

