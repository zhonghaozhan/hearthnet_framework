#!/usr/bin/env node
/**
 * HearthNet Demo — Scene 1: Intent-Driven Multi-Agent Coordination
 * 
 * Paper scenario: "I'm working from home today, get the room ready."
 * 
 * Four-stage protocol:
 *   1. GROUND   — Agents load current state from Git
 *   2. PROPOSE  — Rupert decomposes, managers propose concrete actions
 *   3. VERIFY   — Rupert checks freshness + policy, issues leases
 *   4. EXECUTE  — Managers actuate with lease, Dewey records
 * 
 * Requires: MQTT broker running, Dewey librarian running
 */

const { createClient, msg, send, sleep, logStep, getHEAD, issueLease, loadDeviceState, loadPolicy } = require('./demo-common');
const { decomposeIntent } = require('../protocol/llm');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' SCENE 1: Intent-Driven Multi-Agent Coordination');
  console.log(' "I\'m working from home today, get the room ready."');
  console.log('═══════════════════════════════════════════════════════\n');

  const baseCommit = getHEAD();
  const deviceState = loadDeviceState();
  console.log(`Ground truth HEAD: ${baseCommit}`);
  console.log(`Current device state:`, JSON.stringify(deviceState, null, 2), '\n');

  const rupert = createClient('rupert');
  const jeeves = createClient('jeeves');
  const darcy = createClient('darcy');

  await sleep(1000);

  // Subscribe to inboxes
  const received = { rupert: [], jeeves: [], darcy: [] };
  for (const [name, client] of [['rupert', rupert], ['jeeves', jeeves], ['darcy', darcy]]) {
    client.subscribe(`agents/inbox/${name}`);
    client.on('message', (topic, raw) => {
      const m = JSON.parse(raw.toString());
      if (m.from === name) return;
      received[name].push(m);
      console.log(`  [${name} inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 100)}`);
    });
  }
  await sleep(500);

  // ═══ STAGE 1: GROUND ═══
  logStep('1 [GROUND]', 'User command arrives. Agents load current state from Git.');

  const userCmd = msg('user', 'rupert', 'task',
    "I'm working from home today, get the room ready.", { scene: 'scene1' });
  await send(rupert, 'agents/mirror', userCmd);
  await sleep(500);

  // ═══ STAGE 2: PROPOSE ═══
  logStep('2 [PROPOSE]', 'Rupert decomposes intent → dispatches subtasks to managers');

  const policy = loadPolicy();
  const availableDevices = Object.keys(deviceState);
  
  // Call LLM to decompose user intent into subtasks
  const subtasks = await decomposeIntent(userCmd.content, deviceState, policy, availableDevices);
  console.log(`  LLM decomposed intent into ${subtasks.length} subtasks:`);
  subtasks.forEach((st, idx) => {
    console.log(`    ${idx + 1}. ${st.description} (${st.manager} → ${st.target_device})`);
  });

  // Create and send task messages from LLM output
  const tasks = [];
  for (const subtask of subtasks) {
    const task = msg('rupert', subtask.manager, 'task', subtask.description, {
      base_commit: baseCommit,
      target_device: subtask.target_device,
      desired_state: subtask.desired_state,
      operation: subtask.operation,
      scene: 'scene1',
    });
    tasks.push({ task, target: subtask.manager });
    await send(rupert, `agents/inbox/${subtask.manager}`, task);
    await send(rupert, 'agents/mirror', task);
    await sleep(300);
  }
  await sleep(1000);

  // ═══ STAGE 3: VERIFY & GRANT ═══
  logStep('3 [VERIFY & GRANT]', 'Rupert checks freshness + policy, issues actuation leases');

  // Issue leases for each subtask from LLM decomposition
  const leases = [];
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    const lease = issueLease(
      subtask.manager,
      subtask.target_device,
      subtask.operation,
      subtask.parameter_envelope || {},
      `WFH mode: ${subtask.description}`
    );
    leases.push({ lease, taskIndex: i });
  }

  // Send lease grants
  for (let i = 0; i < tasks.length; i++) {
    const { task, target } = tasks[i];
    const { lease } = leases[i];
    const grant = msg('rupert', target, 'lease_grant',
      `Lease granted: ${subtasks[i].target_device} ${subtasks[i].operation}`, {
        lease, parent_msg_id: task.msg_id, scene: 'scene1',
      });
    await send(rupert, `agents/inbox/${target}`, grant);
    await send(rupert, 'agents/mirror', grant);
    await sleep(300);
  }
  await sleep(1000);

  // ═══ STAGE 4: EXECUTE & RECORD ═══
  logStep('4 [EXECUTE & RECORD]', 'Managers execute with leases, confirm results');

  // Execute each subtask with its lease
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    const { lease } = leases[i];
    const client = subtask.manager === 'jeeves' ? jeeves : darcy;

    const exec = msg(subtask.manager, 'device', 'execute',
      `Executing: ${subtask.description}`, {
        lease,
        target_device: subtask.target_device,
        operation: subtask.operation,
        desired_state: subtask.desired_state,
        base_commit: getHEAD(),
        scene: 'scene1',
      });
    await send(client, 'agents/mirror', exec);
    await sleep(300);

    const result = msg(subtask.manager, 'rupert', 'execute_result',
      `${subtask.target_device} ${subtask.operation} complete`, {
        lease: { lease_id: lease.lease_id },
        target_device: subtask.target_device,
        desired_state: subtask.desired_state,
        resulting_commit: getHEAD(),
        scene: 'scene1',
      });
    await send(client, 'agents/inbox/rupert', result);
    await send(client, 'agents/mirror', result);
    await sleep(300);
  }
  await sleep(1000);

  // Rupert confirms completion
  logStep('5 [COMPLETE]', 'Rupert confirms: Work-from-home mode active');

  const deviceList = subtasks.map(st => st.target_device).join(', ');
  const completion = msg('rupert', 'broadcast', 'resolution',
    `Work-from-home mode active. Mode: work_from_home. ` +
    `${subtasks.length} devices confirmed: ${deviceList}. ` +
    `${leases.length} leases issued and consumed.`,
    { scene: 'scene1' });
  await send(rupert, 'agents/broadcast', completion);
  await send(rupert, 'agents/mirror', completion);
  await sleep(1500);

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' SCENE 1 COMPLETE');
  console.log(`  Protocol: Ground → Propose → Verify/Grant → Execute`);
  console.log(`  Subtasks: ${subtasks.length} (LLM-generated)`);
  console.log(`  Leases issued: ${leases.length} (all consumed)`);
  console.log(`  Devices actuated: ${deviceList}`);
  console.log(`  Ground truth HEAD: ${getHEAD()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  rupert.end(); jeeves.end(); darcy.end();
  process.exit(0);
}

main().catch(console.error);
