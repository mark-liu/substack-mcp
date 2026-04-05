#!/usr/bin/env node
// Live integration test against Substack API
// Tests: auth validation, list drafts, create draft, get draft, delete draft

import { SubstackHTTP } from './dist/client/http.js';
import { SubstackReader } from './dist/client/reader.js';
import { SubstackWriter } from './dist/client/writer.js';
import { markdownToProseMirror } from './dist/converters/markdown.js';

const TOKEN = process.env.SUBSTACK_SESSION_TOKEN;
const PUB_URL = process.env.SUBSTACK_PUBLICATION_URL || 'https://idlepig.substack.com';

if (!TOKEN) {
  console.error('SUBSTACK_SESSION_TOKEN required');
  process.exit(1);
}

const config = {
  publicationUrl: PUB_URL,
  sessionToken: TOKEN,
  enableWrite: true,
  rateLimitPerSecond: 1,
  maxRetries: 3,
};

let passed = 0;
let failed = 0;
let createdDraftId = null;

function ok(name) { passed++; console.log(`  PASS: ${name}`); }
function fail(name, err) { failed++; console.error(`  FAIL: ${name} — ${err}`); }

try {
  const http = new SubstackHTTP(config);
  const reader = new SubstackReader(http);
  const writer = new SubstackWriter(http);

  // Test 1: List published posts
  console.log('\n--- Test 1: List published posts ---');
  try {
    const published = await reader.listPublished({ limit: 3 });
    if (Array.isArray(published) && published.length > 0) {
      ok(`Got ${published.length} published posts`);
      console.log(`    First: "${published[0]?.title || published[0]?.draft_title}"`);
    } else {
      fail('List published', 'Empty or not array');
    }
  } catch (e) { fail('List published', e.message); }

  // Test 2: List drafts
  console.log('\n--- Test 2: List drafts ---');
  try {
    const drafts = await reader.listDrafts({ limit: 5 });
    if (Array.isArray(drafts)) {
      ok(`Got ${drafts.length} drafts`);
    } else {
      fail('List drafts', 'Not array');
    }
  } catch (e) { fail('List drafts', e.message); }

  // Test 3: Get subscriber count
  console.log('\n--- Test 3: Get subscriber count ---');
  try {
    const count = await reader.getSubscriberCount();
    if (typeof count === 'number' && count >= 0) {
      ok(`Subscriber count: ${count}`);
    } else {
      fail('Subscriber count', `Unexpected value: ${count}`);
    }
  } catch (e) { fail('Subscriber count', e.message); }

  // Test 4: Create a test draft
  console.log('\n--- Test 4: Create draft ---');
  try {
    const testDoc = markdownToProseMirror('This is a **live integration test**. Safe to delete.', 'MCP Integration Test');
    const draft = await writer.createDraft(
      'MCP Integration Test — DELETE ME',
      testDoc,
      { subtitle: 'Automated test draft', audience: 'everyone' }
    );
    if (draft && (draft.id || draft.draft_id)) {
      createdDraftId = String(draft.id || draft.draft_id);
      ok(`Created draft ID: ${createdDraftId}`);
    } else {
      fail('Create draft', `Unexpected response: ${JSON.stringify(draft).substring(0, 200)}`);
    }
  } catch (e) { fail('Create draft', e.message); }

  // Test 5: Get the created draft
  if (createdDraftId) {
    console.log('\n--- Test 5: Get created draft ---');
    try {
      const fetched = await reader.getDraft(parseInt(createdDraftId, 10));
      if (fetched && (fetched.draft_title || fetched.title)) {
        ok(`Fetched draft: "${fetched.draft_title || fetched.title}"`);
      } else {
        fail('Get draft', 'Missing title in response');
      }
    } catch (e) { fail('Get draft', e.message); }

    // Test 6: Delete the test draft
    console.log('\n--- Test 6: Delete draft ---');
    try {
      await writer.deleteDraft(parseInt(createdDraftId, 10));
      ok(`Deleted draft ${createdDraftId}`);
    } catch (e) { fail('Delete draft', e.message); }
  }

  // Test 7: Get tags
  console.log('\n--- Test 7: Get tags ---');
  try {
    const tags = await reader.getTags();
    if (Array.isArray(tags)) {
      ok(`Got ${tags.length} tags`);
    } else {
      fail('Get tags', 'Not array');
    }
  } catch (e) { fail('Get tags', e.message); }

} catch (e) {
  console.error(`\nFATAL: ${e.message}`);
  failed++;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
