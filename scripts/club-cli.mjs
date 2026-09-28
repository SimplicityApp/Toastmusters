#!/usr/bin/env node
/**
 * Minting and rotating clubs by hand, until payment does it.
 *
 * At launch a human runs this over what checkout captured and emails the code
 * with a personal note. The work itself is not in here: it is in
 * `worker/club-admin.js`, called with a KV namespace that happens to be a
 * wrangler subprocess rather than a Worker binding. Automating club creation
 * later means calling the same `createClubFromPending()` from the Stripe
 * webhook, with nothing to re-derive.
 *
 * The everyday path is `pending` then `create --pending <cus_id>`: checkout
 * parks the buyer's uid, the club name they typed and the address Stripe
 * collected under `club-pending:<cus_id>`, and this turns one of those into a
 * club without anyone retyping it out of the Stripe dashboard.
 *
 * Usage:
 *   node scripts/club-cli.mjs pending --env dev
 *   node scripts/club-cli.mjs create  --env dev --pending cus_123 [--name "Downtown Speakers"] [--tz America/Toronto]
 *   node scripts/club-cli.mjs create  --env dev --name "Downtown Speakers" --uid <zoom uid> [--tz America/Toronto] [--email x@y.z] [--prefix DTSP]
 *   node scripts/club-cli.mjs rotate  --env dev --club <clubId>
 *   node scripts/club-cli.mjs show    --env dev --club <clubId> | --code DTSP-7K2QM9
 */

import { spawnSync } from 'node:child_process';
import {
  createClubFromPending,
  rotateClubCode,
  normalizeCode,
  formatCode,
  clubByCodeKey,
  clubPendingKey,
  CLUB_PENDING_PREFIX,
} from '../worker/club-admin.js';
import { clubKey } from '../worker/entitlements.js';

const BINDING = 'PROFILES';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    const name = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (allowFailure) return null;
    process.stderr.write(result.stderr || '');
    throw new Error(`wrangler ${args.join(' ')} failed with status ${result.status}`);
  }
  return result.stdout ?? '';
}

/**
 * A KV namespace shaped like the Worker binding, backed by the wrangler CLI.
 *
 * `--remote` is not optional: without it wrangler reads and writes the local
 * simulated store, and the club would exist only on this laptop.
 */
function kvNamespace(envName) {
  const scope = ['--binding', BINDING, '--remote', ...(envName ? ['--env', envName] : [])];

  return {
    async get(key, type) {
      const raw = wrangler(['kv', 'key', 'get', ...scope, key], { allowFailure: true });
      if (raw === null) return null;
      const text = raw.trim();
      if (!text) return null;
      if (type !== 'json') return text;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async put(key, value) {
      wrangler(['kv', 'key', 'put', ...scope, key, value]);
    },
    async delete(key) {
      wrangler(['kv', 'key', 'delete', ...scope, key], { allowFailure: true });
    },
    async list({ prefix = '' } = {}) {
      const raw = wrangler(['kv', 'key', 'list', ...scope, '--prefix', prefix], { allowFailure: true });
      try {
        return { keys: JSON.parse(raw ?? '[]'), list_complete: true };
      } catch {
        return { keys: [], list_complete: true };
      }
    },
  };
}

const envFlag = (flags) => (typeof flags.env === 'string' ? ` --env ${flags.env}` : '');

/** One payment that has not become a club yet. */
async function readPending(store, customerId) {
  return store.get(clubPendingKey(customerId), 'json');
}

/**
 * Every payment still waiting for a club.
 *
 * The inbox the manual bridge works from: checkout persisted the raw material
 * at the moment it existed, so minting a club is reading this list rather than
 * digging through the Stripe dashboard.
 */
async function listPending(store) {
  const { keys } = await store.list({ prefix: CLUB_PENDING_PREFIX });
  const out = [];
  for (const entry of keys ?? []) {
    const customerId = entry.name.slice(CLUB_PENDING_PREFIX.length);
    // eslint-disable-next-line no-await-in-loop
    const record = await readPending(store, customerId);
    if (record) out.push({ customerId, record });
  }
  return out;
}

function printClub(clubId, club) {
  process.stdout.write(
    [
      '',
      `  club id   ${clubId}`,
      `  name      ${club.name}`,
      `  code      ${formatCode(club.code)}`,
      `  ver       ${club.ver}`,
      `  status    ${club.status}`,
      `  timezone  ${club.timezone ?? '(device default)'}`,
      `  billing   ${club.billingEmail ?? '(none — the magic-link door will not work)'}`,
      `  link      https://www.timer.toastmusters.com/pro/${formatCode(club.code)}`,
      '  console   https://www.timer.toastmusters.com/club/admin',
      '',
    ].join('\n')
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const env = { PROFILES: kvNamespace(flags.env === true ? undefined : flags.env) };

  if (command === 'pending') {
    const waiting = await listPending(env.PROFILES);
    if (!waiting.length) {
      process.stdout.write('\n  Nothing waiting. Every payment has become a club.\n\n');
      return;
    }
    process.stdout.write(`\n  ${waiting.length} payment${waiting.length === 1 ? '' : 's'} waiting for a club:\n`);
    for (const { customerId, record } of waiting) {
      process.stdout.write(
        [
          '',
          `  customer  ${customerId}`,
          `  name      ${record.clubName ?? '(none typed — a placeholder will be minted)'}`,
          `  buyer     ${record.uid ?? '(no uid — nobody will be an admin)'}`,
          `  billing   ${record.email ?? '(none — the magic-link door will not work)'}`,
          `  paid      ${record.paidAt ? new Date(record.paidAt).toISOString() : '(unknown)'}`,
          `  mint it   node scripts/club-cli.mjs create${envFlag(flags)} --pending ${customerId}`,
          '',
        ].join('\n')
      );
    }
    return;
  }

  if (command === 'create') {
    // The everyday path: everything but the timezone came out of checkout, so
    // there is nothing to retype and nothing to mistype.
    const pending = typeof flags.pending === 'string' ? await readPending(env.PROFILES, flags.pending) : null;
    if (typeof flags.pending === 'string' && !pending) {
      throw new Error(`No pending record at ${clubPendingKey(flags.pending)}`);
    }
    if (!pending && !flags.name) throw new Error('--name (or --pending <cus_id>) is required');

    const { clubId, club } = await createClubFromPending(
      env,
      {
        // Explicit flags win over what checkout captured: an operator correcting
        // a typo in the buyer's club name should not have to edit KV first.
        clubName: typeof flags.name === 'string' ? flags.name : (pending?.clubName ?? null),
        uid: typeof flags.uid === 'string' ? flags.uid : (pending?.uid ?? null),
        email: typeof flags.email === 'string' ? flags.email : (pending?.email ?? null),
        stripeCustomerId:
          typeof flags.customer === 'string'
            ? flags.customer
            : (pending?.stripeCustomerId ?? (typeof flags.pending === 'string' ? flags.pending : null)),
        timezone: typeof flags.tz === 'string' ? flags.tz : null,
      },
      // The prefix is cosmetic and carries no entropy — the six-character
      // suffix is where all the unguessability lives — so overriding it is safe.
      typeof flags.prefix === 'string' ? { prefix: flags.prefix } : {}
    );

    printClub(clubId, club);
    if (!(typeof flags.uid === 'string' || pending?.uid)) {
      process.stdout.write('  (no uid: nobody is an admin of this club yet)\n');
    }
    if (typeof flags.pending === 'string') {
      // Dropped only after the club is written, so a crash in between leaves
      // the payment waiting rather than losing it.
      await env.PROFILES.delete(clubPendingKey(flags.pending));
      process.stdout.write(`  (cleared ${clubPendingKey(flags.pending)})\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (command === 'rotate') {
    if (typeof flags.club !== 'string') throw new Error('--club <clubId> is required');
    const { club, revoked } = await rotateClubCode(env, flags.club);
    printClub(flags.club, club);
    process.stdout.write(`  revoked ${revoked} device${revoked === 1 ? '' : 's'}; every cached code is now dead\n\n`);
    return;
  }

  if (command === 'show') {
    let clubId = typeof flags.club === 'string' ? flags.club : null;
    if (!clubId && typeof flags.code === 'string') {
      clubId = await env.PROFILES.get(clubByCodeKey(normalizeCode(flags.code)));
    }
    if (!clubId) throw new Error('--club <clubId> or --code <CODE> is required');
    const club = await env.PROFILES.get(clubKey(clubId), 'json');
    if (!club) throw new Error(`No club record at ${clubKey(clubId)}`);
    printClub(clubId, club);
    return;
  }

  process.stdout.write(
    [
      '',
      'Usage:',
      '  node scripts/club-cli.mjs pending --env dev',
      '  node scripts/club-cli.mjs create  --env dev --pending cus_123 [--name "Downtown Speakers"] [--tz America/Toronto]',
      '  node scripts/club-cli.mjs create  --env dev --name "Downtown Speakers" --uid <zoom uid> [--tz America/Toronto] [--email x@y.z] [--prefix DTSP]',
      '  node scripts/club-cli.mjs rotate  --env dev --club <clubId>',
      '  node scripts/club-cli.mjs show    --env dev --club <clubId> | --code DTSP-7K2QM9',
      '',
      'Omit --env to act on production.',
      '',
    ].join('\n')
  );
  process.exitCode = command ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
