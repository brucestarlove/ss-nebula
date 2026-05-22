#!/usr/bin/env node

/**
 * (UNTESTED) Script to clear Firebase Auth users and Firestore collections
 * 
 * Setup:
 * 1. Download your Firebase service account key from:
 *    Firebase Console > Project Settings > Service Accounts > Generate New Private Key
 * 2. Set the GOOGLE_APPLICATION_CREDENTIALS environment variable:
 *    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 * 
 * Usage: 
 *    node scripts/clearFirebaseData.cjs
 * 
 * Or in one line:
 *    GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json" node scripts/clearFirebaseData.cjs
 * 
 * This script will:
 * - Delete all Firebase Auth users
 * - Delete all documents from: users, userPreferences
 * - Delete all canvases except "main" (canvases include metadata)
 * 
 * CAUTION: This is a destructive operation. Use only in development!
 */

const admin = require('firebase-admin');
const readline = require('readline');

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'collabcanvas-2a674'
  });
}

const auth = admin.auth();
const db = admin.firestore();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

async function deleteAllAuthUsers() {
  console.log('\n📋 Fetching all Auth users...');
  
  let totalDeleted = 0;
  let nextPageToken;
  
  do {
    try {
      const listUsersResult = await auth.listUsers(1000, nextPageToken);
      const uids = listUsersResult.users.map(user => user.uid);
      
      if (uids.length === 0) {
        break;
      }
      
      console.log(`   Deleting ${uids.length} users...`);
      await auth.deleteUsers(uids);
      totalDeleted += uids.length;
      
      nextPageToken = listUsersResult.pageToken;
    } catch (error) {
      console.error('   ❌ Error deleting auth users:', error);
      throw error;
    }
  } while (nextPageToken);
  
  console.log(`✅ Deleted ${totalDeleted} Auth users`);
  return totalDeleted;
}

async function deleteCollection(collectionName, excludeDocId = null) {
  console.log(`\n📋 Deleting collection: ${collectionName}`);
  
  const collectionRef = db.collection(collectionName);
  const batchSize = 500;
  let totalDeleted = 0;
  
  let query = collectionRef.limit(batchSize);
  
  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, excludeDocId, batchSize, totalDeleted, resolve, reject);
  });
}

async function deleteQueryBatch(query, excludeDocId, batchSize, totalDeleted, resolve, reject) {
  try {
    const snapshot = await query.get();
    
    if (snapshot.size === 0) {
      console.log(`✅ Deleted ${totalDeleted} documents`);
      resolve(totalDeleted);
      return;
    }
    
    const batch = db.batch();
    let batchCount = 0;
    
    snapshot.docs.forEach((doc) => {
      if (excludeDocId && doc.id === excludeDocId) {
        console.log(`   ⏭️  Skipping document: ${doc.id}`);
        return;
      }
      batch.delete(doc.ref);
      batchCount++;
    });
    
    await batch.commit();
    totalDeleted += batchCount;
    console.log(`   Deleted batch of ${batchCount} documents (total: ${totalDeleted})`);
    
    // Recurse on the next batch
    process.nextTick(() => {
      deleteQueryBatch(query, excludeDocId, batchSize, totalDeleted, resolve, reject);
    });
  } catch (error) {
    console.error('   ❌ Error deleting batch:', error);
    reject(error);
  }
}

async function deleteSubcollections(parentCollectionName, excludeDocId = null) {
  console.log(`\n📋 Checking for subcollections in: ${parentCollectionName}`);
  
  const parentRef = db.collection(parentCollectionName);
  const snapshot = await parentRef.get();
  
  let totalDeleted = 0;
  
  for (const doc of snapshot.docs) {
    if (excludeDocId && doc.id === excludeDocId) {
      console.log(`   ⏭️  Skipping document and its subcollections: ${doc.id}`);
      continue;
    }
    
    const subcollections = await doc.ref.listCollections();
    
    for (const subcollection of subcollections) {
      console.log(`   Deleting subcollection: ${doc.id}/${subcollection.id}`);
      const deleted = await deleteCollection(`${parentCollectionName}/${doc.id}/${subcollection.id}`);
      totalDeleted += deleted;
    }
  }
  
  if (totalDeleted > 0) {
    console.log(`✅ Deleted ${totalDeleted} documents from subcollections`);
  } else {
    console.log(`   No subcollections found`);
  }
  
  return totalDeleted;
}

async function clearAllData() {
  console.log('\n🔥 FIREBASE DATA CLEARING SCRIPT 🔥');
  console.log('====================================');
  console.log('\n⚠️  WARNING: This will delete:');
  console.log('   - All Firebase Auth users');
  console.log('   - All documents in: users');
  console.log('   - All documents in: userPreferences');
  console.log('   - All canvases EXCEPT "main" (includes metadata and subcollections)');
  console.log('\n⚠️  This operation is IRREVERSIBLE!\n');
  
  const answer = await question('Type "DELETE ALL" to confirm: ');
  
  if (answer !== 'DELETE ALL') {
    console.log('\n❌ Operation cancelled.');
    rl.close();
    process.exit(0);
  }
  
  console.log('\n🚀 Starting data deletion...\n');
  
  try {
    // Delete Auth users
    await deleteAllAuthUsers();
    
    // Delete Firestore collections
    await deleteCollection('users');
    await deleteCollection('userPreferences');
    
    // Delete all canvases except "main" (metadata is now stored in canvas documents)
    await deleteCollection('canvases', 'main');
    
    // Check and delete any subcollections
    console.log('\n📋 Checking for subcollections...');
    await deleteSubcollections('canvases', 'main');
    
    console.log('\n✅ ✅ ✅ ALL DATA CLEARED SUCCESSFULLY! ✅ ✅ ✅\n');
    
  } catch (error) {
    console.error('\n❌ Error during data deletion:', error.message || error);
    console.error('\n💡 Tip: Make sure GOOGLE_APPLICATION_CREDENTIALS is set to your service account key path.');
    console.error('   See the comments at the top of this file for setup instructions.\n');
    process.exit(1);
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Run the script
clearAllData();

