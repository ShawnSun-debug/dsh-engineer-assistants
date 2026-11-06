import assert from 'node:assert/strict'
import test from 'node:test'
import { DRAFT_MAX_CHARS, applyDraftTriggers, createDraftStore, nudgeTextOf } from '../lib/secretary-nudge.js'
import { SecretaryRemote } from '../lib/secretary-panel.js'

// ---- 催办草稿（秘书 spec 票 08） ----------------------------------------------------------
//
// The draft is a pending suggestion until the user confirms it: generating one must not
// message anyone, and only a successful delivery may move it to 'sent'. These cases use a
// fake messaging adapter that records every call, so "nothing was sent" is observable.

/** A messaging stand-in: records the call and answers what the case asked for. */
function fakeMessaging(outcome = { delivered: true }) {
  const calls = []
  return {
    calls,
    async deliver(target, text, senderSessionId) {
      calls.push({ target, text, senderSessionId })
      return outcome
    },
  }
}

/** A store with one pending draft from a Needs-input session, seeded through the real trigger. */
function seeded({ state = 'Needs input', now = 1000 } = {}) {
  const store = createDraftStore()
  applyDraftTriggers({ store, orchestrators: [{ sessionId: 's-1', title: '构建', state }], now })
  return store
}

function remoteOf(store, messaging, masterSessionId = 'master-1') {
  return new SecretaryRemote({
    enabled: () => true,
    read: async () => ({ drafts: store.list() }),
    drafts: store,
    masterSessionId,
    messaging,
  })
}

test('a Needs input session yields one pending draft and the next poll reuses it (why: the view re-reads every ten seconds)', () => {
  const store = createDraftStore()
  const orchestrators = [{ sessionId: 's-1', title: '构建', state: 'Needs input' }]
  applyDraftTriggers({ store, orchestrators, conflict: null, now: 1000 })
  applyDraftTriggers({ store, orchestrators, conflict: null, now: 2000 })

  const drafts = store.list()
  assert.equal(drafts.length, 1, 'same session + same reason while pending is one draft')
  assert.deepEqual(Object.keys(drafts[0]), ['id', 'sessionId', 'reason', 'text', 'status', 'createdAt', 'sentAt'])
  assert.equal(drafts[0].sessionId, 's-1')
  assert.equal(drafts[0].reason, 'needs-input')
  assert.equal(drafts[0].status, 'pending')
  assert.equal(drafts[0].createdAt, 1000, 'the first draft keeps its creation time')
  assert.equal(drafts[0].sentAt, null)
  assert.match(drafts[0].text, /构建/)
  assert.match(drafts[0].text, /确认/)
  assert.ok([...drafts[0].text].length <= DRAFT_MAX_CHARS)
})

test('a registry conflict yields its own draft and a calm working session adds nothing', () => {
  const store = createDraftStore()
  applyDraftTriggers({
    store,
    orchestrators: [{ sessionId: 's-2', title: '冲突', state: 'Working' }],
    conflict: { masterSessionId: 'm-1', conflictingOrchestratorIds: ['s-2'] },
    now: 10,
  })
  assert.deepEqual(store.list().map((draft) => draft.reason), ['conflict'])
  // A calm working session and an empty conflict make nothing.
  applyDraftTriggers({ store, orchestrators: [{ sessionId: 's-3', title: '安静', state: 'Working' }], conflict: null, now: 20 })
  assert.equal(store.list().length, 1)
})

test('generating a draft sends no message; confirmDraft alone delivers it to the master session', async () => {
  const store = seeded()
  const messaging = fakeMessaging()
  const service = remoteOf(store, messaging)

  const payload = await service.secretaryState()
  assert.equal(payload.drafts.length, 1)
  assert.equal(payload.drafts[0].status, 'pending')
  assert.deepEqual(messaging.calls, [], 'a pending draft must not reach the target session')

  const draft = store.list()[0]
  const result = await service.confirmDraft(draft.id)
  assert.equal(result.delivered, true)
  assert.equal(result.draft.status, 'sent')
  assert.equal(typeof result.draft.sentAt, 'number')
  assert.equal(messaging.calls.length, 1)
  assert.equal(messaging.calls[0].target, 'master-1', 'the target is the registered master session')
  assert.equal(messaging.calls[0].text, draft.text)
  assert.equal(store.get(draft.id).status, 'sent')
})

test('a failed delivery keeps the draft pending and hands the reason back', async () => {
  const store = seeded()
  const messaging = fakeMessaging({ delivered: false, reason: 'no live agent for session master-1' })
  const service = remoteOf(store, messaging)
  const draft = store.list()[0]

  const result = await service.confirmDraft(draft.id)
  assert.equal(result.delivered, false)
  assert.match(result.reason, /no live agent/)
  assert.equal(result.draft.status, 'pending', 'a failed send never claims success')
  assert.equal(store.get(draft.id).status, 'pending')
  assert.equal(store.get(draft.id).sentAt, null)
})

test('discardDraft archives the draft, and a later confirm cannot send it', async () => {
  const store = seeded()
  const messaging = fakeMessaging()
  const service = remoteOf(store, messaging)
  const draft = store.list()[0]

  const discarded = await service.discardDraft(draft.id)
  assert.equal(discarded.draft.status, 'discarded')
  assert.deepEqual(messaging.calls, [], 'discarding never sends')

  const result = await service.confirmDraft(draft.id)
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'draft-decided')
  assert.deepEqual(messaging.calls, [], 'a decided draft is never delivered twice')
})

test('a draft decided while the send is in flight reports the real state and is never sent twice', async () => {
  const warnings = []
  const store = createDraftStore({ warn: (message) => warnings.push(message) })
  applyDraftTriggers({
    store,
    orchestrators: [{ sessionId: 's-1', title: '构建', state: 'Needs input' }],
    now: 1000,
  })
  const draft = store.list()[0]
  const messaging = fakeMessaging()
  const racing = {
    calls: messaging.calls,
    async deliver(target, text, senderSessionId) {
      // The user archives the draft while the confirmation is in flight, so the
      // 'sent' transition is refused after the message already went out.
      await service.discardDraft(draft.id)
      return messaging.deliver(target, text, senderSessionId)
    },
  }
  const service = remoteOf(store, racing)

  const result = await service.confirmDraft(draft.id)
  assert.equal(result.delivered, true, 'the message really did go out')
  assert.equal(result.reason, 'state-not-recorded')
  assert.equal(result.draft.status, 'discarded', 'the returned draft carries the state the store actually has')
  assert.equal(warnings.length, 1, 'the refused transition is recorded once as a warning')
  assert.match(warnings[0], /not recorded/)

  const again = await service.confirmDraft(draft.id)
  assert.equal(again.delivered, false)
  assert.equal(again.reason, 'draft-decided')
  assert.equal(messaging.calls.length, 1, 'a delivered draft is never sent a second time')
})

test('an unknown draft id is a named failure, not a silent success', async () => {
  const store = seeded()
  const service = remoteOf(store, fakeMessaging())
  const result = await service.confirmDraft('draft-missing')
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'draft-missing')
  assert.equal(store.list()[0].status, 'pending')
})

test('the template names the blocker, suggests what to confirm, and stays under 300 characters', () => {
  const needs = nudgeTextOf({ title: '构建', reason: 'needs-input' })
  assert.match(needs, /构建/)
  assert.match(needs, /确认/)
  const failed = nudgeTextOf({ title: '构建', reason: 'error', detail: 'boom' })
  assert.match(failed, /boom/)
  const conflict = nudgeTextOf({ title: '构建', reason: 'conflict' })
  assert.match(conflict, /Master/)
  const long = nudgeTextOf({ title: '构建', reason: 'error', detail: 'x'.repeat(1000) })
  assert.ok([...long].length <= DRAFT_MAX_CHARS, 'a long error is clamped, not pasted whole')
})
