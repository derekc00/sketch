import { createMachine, assign, enqueueActions } from 'xstate';
// DESIGN PROTOTYPE — confirmed product decisions, 2026-10-18.
// Guided video/photo fallback; Pickup Replacement renews paid hour and preserves Exchange.
// Return exceptions end Sessions with profile/review flags; our team owns readiness.
// SIMULATION: logical elapsed time; five free inspection minutes, then a fresh paid hour.
// Five-minute guarantee from initial/each Pickup Replacement access; timely report protects later return.
// Option C: authorize before access; capture only after accepted final return and inspection/entitlement checks.
// Release uncaptured holds / refund captured payments after eligible accepted return.
// No real media, locks, payment, identities, evidence checks or permissions.
// Door open/closed and secured events are simulated; physical signal mapping needs validation.
const identifiedAccess = ({ event }) => typeof event.podId === 'string' && event.podId.length > 0
  && typeof event.unitId === 'string' && event.unitId.length > 0;
const recordSourceUnit = assign({
  sourcePodId: ({ event }) => event.podId, sourceUnitId: ({ event }) => event.unitId,
});
const matchingOutageSession = ({ context, event }) => typeof context.sessionId === 'string'
  && context.sessionId.length > 0 && event.sessionId === context.sessionId
  && typeof event.podId === 'string' && event.podId.length > 0
  && event.podId === (context.sourcePodId ?? context.podId);
const favorableOutageAssessment = ({ context, event }) => matchingOutageSession({ context, event })
  && event.outageConfirmed === true && event.customerFavorable === true
  && ['customer_account', 'inventory_match', 'reasonable_assumption'].includes(event.basis);
const currentReturnDoor = ({ context, event }) => context.returnUnitId !== null
  && event.podId === context.sourcePodId && event.unitId === context.returnUnitId
  && event.attempt === context.returnAccessAttempt;
// Forward this emitted event to the Pod actor in the application (runtime tests simulate the bridge).
// A trusted deposit event may precede media acceptance; acceptance also supplies it if still unreported.
const reportAuxiliaryDeposit = enqueueActions(({ context, enqueue }) => {
  if (!context.returnUnitIsAuxiliary || context.auxiliaryDepositReported) return;
  enqueue.assign({ auxiliaryDepositReported: true });
  enqueue.emit({ type: 'system.AUXILIARY_RETURN_CONFIRMED', podId: context.sourcePodId,
    returnId: `${context.sessionId}:${context.returnAccessAttempt}`, unitId: context.returnUnitId });
});
const requestReturnUnlock = assign({
  returnAccessAttempt: ({ context }) => context.returnAccessAttempt + 1,
  returnDoorState: 'unknown', returnDoorOpened: false, returnUnlockStatus: 'requested',
  returnAccessIssue: null, unitSecured: false,
});
const pauseFailedReturn = assign({
  firstReturnFailureAtSeconds: ({ context }) => context.firstReturnFailureAtSeconds ?? context.accessElapsedSeconds,
  returnPaidClockPausedBeforeFailure: ({ context }) => context.returnFailurePending
    ? context.returnPaidClockPausedBeforeFailure : context.paidClockPaused,
  returnFailurePending: true, paidClockPaused: true, unitSecured: false,
});
const returnDoorFailure = (reason) => ({
  guard: currentReturnDoor,
  actions: [pauseFailedReturn, assign({ returnAccessIssue: reason })],
});
const canAssignFallback = ({ context }) => context.returnAccessIssue !== 'unlock_failed'
  || (context.returnDestinationKind === 'source' && context.sourceUnlockRetries === 1);
const openingFailed = {
  guard: ({ context, event }) => currentReturnDoor({ context, event })
    && !context.returnDoorOpened && context.returnUnlockStatus !== 'failed',
  actions: [pauseFailedReturn, assign({ returnAccessIssue: 'unlock_failed', returnUnlockStatus: 'failed',
    returnOpeningRecovery: ({ context }) => context.returnDestinationKind === 'fallback' ? 'assistance_required'
      : context.sourceUnlockRetries === 0 ? 'retry_available' : 'fallback_needed',
  })],
};
const returnDoorEvents = {
  'renter.REQUEST_RETURN_UNLOCK': [
    { guard: ({ context }) => context.returnAccessIssue === 'unlock_failed'
        && context.returnDestinationKind === 'source' && context.sourceUnlockRetries === 0,
      actions: [requestReturnUnlock, assign({ sourceUnlockRetries: 1, returnOpeningRecovery: 'retry_in_progress' })],
      description: 'One source retry after the first opening failure; paid time stays paused.' },
    { guard: ({ context }) => context.returnAccessIssue !== 'unlock_failed'
        && context.returnOpeningRecovery !== 'assistance_required'
        && (context.returnAccessIssue !== null || context.returnDoorState === 'closed'),
      actions: requestReturnUnlock,
      description: 'Reopen a closed door or retry another physical issue; Q05b–d remedies remain open.' },
  ],
  'system.RETURN_UNLOCK_CONFIRMED': {
    guard: ({ context, event }) => currentReturnDoor({ context, event }) && context.returnUnlockStatus === 'requested'
      && context.returnAccessIssue === null,
    actions: assign({ returnUnlockStatus: 'confirmed' }),
  },
  'system.RETURN_DOOR_OPENED': { guard: currentReturnDoor,
    actions: assign({ returnDoorState: 'open', returnDoorOpened: true, unitSecured: false,
      returnAccessIssue: ({ context }) => context.returnAccessIssue === 'unlock_failed' ? null : context.returnAccessIssue,
      returnOpeningRecovery: 'door_open',
    }),
    description: 'Sensor feedback while the Renter records condition information; upload never secures a door.' },
  'system.RETURN_DOOR_CLOSED': { guard: currentReturnDoor,
    actions: assign({ returnDoorState: 'closed' }),
  },
  'system.RETURN_UNIT_SECURED': {
    guard: ({ context, event }) => currentReturnDoor({ context, event }) && context.returnDoorOpened
      && context.returnDoorState === 'closed' && context.returnAccessIssue === null,
    actions: assign({ unitSecured: true }),
    description: 'Trusted secure confirmation for this Unit/attempt; closed alone is insufficient.' },
  'system.AUXILIARY_DEPOSIT_CONFIRMED': {
    guard: ({ context, event }) => currentReturnDoor({ context, event }) && context.returnUnitIsAuxiliary
      && context.unitSecured && context.returnDoorState === 'closed' && context.returnAccessIssue === null,
    actions: reportAuxiliaryDeposit,
    description: 'Trusted physical deposit confirmation, not assignment/opening alone. Suspend Pod admission even before media/payment completes.',
  },
  'system.RETURN_UNLOCK_FAILED': openingFailed,
  'system.RETURN_OPEN_FAILED': openingFailed,
  'system.RETURN_SECURE_FAILED': returnDoorFailure('secure_failed'),
  // Q05: Source Unit occupancy is excluded; this event represents physical obstruction/fit issues.
  // Preserving return capacity across Sessions requires an allocation model outside this prototype.
  'system.RETURN_DESTINATION_UNAVAILABLE': { ...returnDoorFailure('destination_unavailable'),
    description: 'Physical obstruction/fit issue; occupied Source Unit is excluded. Remedy remains Q05 OPEN.' },
  'system.NO_COMPATIBLE_RETURN_UNIT': {
    guard: ({ context, event }) => currentReturnDoor({ context, event }) && context.returnAccessIssue !== null
      && canAssignFallback({ context }),
    actions: [pauseFailedReturn, assign({ returnAccessIssue: 'no_compatible_unit', returnOpeningRecovery: 'assistance_required' })],
  },
  'system.ASSIGN_RETURN_FALLBACK': {
    guard: ({ context, event }) => context.returnAccessIssue !== null && !context.unitSecured
      && context.returnOpeningRecovery !== 'assistance_required' && canAssignFallback({ context })
      && event.fromUnitId === context.returnUnitId && event.attempt === context.returnAccessAttempt
      && identifiedAccess({ event }) && event.podId === context.sourcePodId
      && event.unitId !== context.returnUnitId && event.compatible === true && event.available === true,
    actions: [assign({ returnUnitId: ({ event }) => event.unitId, returnDestinationKind: 'fallback', returnOpeningRecovery: 'fallback_in_progress',
      returnUnitIsAuxiliary: ({ event }) => event.auxiliary === true, auxiliaryDepositReported: false,
      openingFallbackAfterSourceFailure: ({ context }) => context.returnAccessIssue === 'unlock_failed'
        && context.returnDestinationKind === 'source' && context.sourceUnlockRetries === 1,
    }), requestReturnUnlock],
    description: 'System-assigned same-Pod fallback. Clear door confirmation, preserve Set evidence and remedy choice.' },
};
const beginReturn = (purpose) => assign({
  returnPurpose: purpose, returnEvidence: null, returnExceptionReason: null, customerReturnTimeRequired: false,
  returnUnitIsAuxiliary: false, auxiliaryDepositReported: false,
  captureBlocked: ({ context }) => purpose === 'finish' ? context.captureBlocked : true,
  paidClockPaused: ({ context }) => ['pickup_recovery', 'fault_recovery', 'guarantee_refund'].includes(purpose) || context.paidClockPaused,
  unitSecured: false, completeSetDeclared: false,
  returnUnitId: ({ context }) => context.sourceUnitId, returnDestinationKind: 'source',
  sourceUnlockRetries: 0, returnOpeningRecovery: 'source_attempt', firstReturnFailureAtSeconds: null,
  openingFallbackAfterSourceFailure: false,
  returnFailurePending: false, returnPaidClockPausedBeforeFailure: null,
  returnAccessAttempt: ({ context }) => context.returnAccessAttempt + 1,
  returnDoorState: 'unknown', returnDoorOpened: false, returnUnlockStatus: 'requested', returnAccessIssue: null,
});
const chooseReturnPurpose = (purpose) => [
  { target: 'ReadyForAcceptance', guard: ({ context }) => context.returnEvidence !== null,
    actions: assign({ returnPurpose: purpose }) },
  { target: 'History', actions: assign({ returnPurpose: purpose }) },
];
const acceptReturn = assign(({ context }) => ({
  returnAssurance: 'confirmed',
  returnFailurePending: false,
  paidClockPaused: context.returnPurpose === 'exchange' && context.returnFailurePending
    ? context.returnPaidClockPausedBeforeFailure : context.paidClockPaused,
  pendingReadinessReviews: context.pendingReadinessReviews + 1,
  profileReturnExceptions: context.profileReturnExceptions
    + Number(context.returnEvidence === 'exception'),
  pendingEvidenceReviews: context.pendingEvidenceReviews
    + Number(context.returnEvidence === 'exception'),
}));
const withinGuarantee = ({ context }) => context.accessElapsedSeconds !== null
  && context.accessElapsedSeconds <= 300;
const recordSatisfaction = assign({
  satisfactionReportedAtSeconds: ({ context }) => context.accessElapsedSeconds,
  reportedEquipmentConcerns: ({ context }) => context.reportedEquipmentConcerns + 1,
  captureBlocked: true, paidClockPaused: true,
});
const satisfactionReport = {
  target: '#rental.SatisfactionChoice', guard: withinGuarantee,
  actions: recordSatisfaction,
};
const advanceAccessClock = (seconds) => ({
  guard: ({ context }) => context.accessElapsedSeconds !== null,
  actions: assign(({ context }) => {
    const elapsed = context.accessElapsedSeconds + seconds;
    const running = !context.paidClockPaused && !context.sessionEnded;
    const paidSeconds = running ? Math.max(0, elapsed - 300)
      - Math.max(0, context.accessElapsedSeconds - 300) : 0;
    return { accessElapsedSeconds: elapsed,
      paidMinutesRemaining: Math.max(0, context.paidMinutesRemaining - paidSeconds / 60),
      paidClockStarted: context.paidClockStarted || (running && elapsed >= 300),
    };
  }),
});
const fullRefund = assign({
  refundStatus: ({ context }) => context.returnFailureCompensated ? context.refundStatus : 'full_refund_due',
  endReason: 'satisfaction_guarantee',
  refundScope: ({ context }) => context.refundScope ?? (context.faultRecovery ? 'whole_transaction' : null),
});
const chooseRefundAfterReturn = {
  target: '#rental.Ended',
  guard: ({ context }) => context.satisfactionReportedAtSeconds !== null,
  actions: fullRefund,
};
const paymentChange = (from, to, refundStatus) => ({
  guard: ({ context }) => context.paymentStatus === from,
  actions: assign(({ context }) => ({
    paymentStatus: typeof to === 'function' ? to(context) : to,
    refundStatus: typeof refundStatus === 'function' ? refundStatus(context) : refundStatus ?? context.refundStatus,
  })),
});
const settleReturnPayment = assign(({ context }) => ({
  paymentStatus: context.refundStatus !== 'full_refund_due' ? context.paymentStatus
    : ({ authorized: 'release_due', captured: 'refund_due' }[context.paymentStatus] ?? context.paymentStatus),
}));
const compensateFailedReturn = {
  guard: ({ context }) => !context.returnFailureCompensated && context.sourceUnlockRetries === 1
    && context.returnOpeningRecovery === 'assistance_required'
    && ((context.returnAccessIssue === 'no_compatible_unit' && context.returnDestinationKind === 'source'
        && context.returnUnlockStatus === 'failed' && !context.returnDoorOpened)
      || (context.openingFallbackAfterSourceFailure && context.returnAccessIssue === 'unlock_failed')),
  actions: [assign({ returnFailureCompensated: true, refundStatus: 'full_refund_due',
    refundScope: 'whole_transaction', refundReason: 'return_access_failure', captureBlocked: true,
  }), settleReturnPayment],
  description: 'Automatically owe full refund/release when opening routes are exhausted; no collection or acceptance guard. Isolated site: assistance_required means unresolved custody, not available outside help. Service Unit/offline/departure rules remain open.',
};
const paymentEvents = {
  'system.REQUEST_CAPTURE': {
    guard: ({ context }) => context.paymentStatus === 'authorized'
      && context.sessionEnded && context.endReason === 'final_return'
      && context.accessElapsedSeconds > 300 && !context.captureBlocked && !context.returnFailurePending
      && context.satisfactionReportedAtSeconds === null && context.refundStatus === 'not_due',
    actions: assign({ paymentStatus: 'capture_pending' }),
    description: 'Option C: accepted final return only; no capture during inspection/play, interim returns, deadlines or unresolved failure.',
  },
  'system.CAPTURE_CONFIRMED': paymentChange('capture_pending',
    (c) => c.refundStatus === 'full_refund_due' ? 'refund_due' : 'captured'),
  'system.CAPTURE_FAILED': paymentChange('capture_pending',
    (c) => c.refundStatus === 'full_refund_due' ? 'release_due' : 'authorized'),
  'system.AUTHORIZATION_EXPIRED': paymentChange('authorized', 'expired_review_required'),
  'system.REQUEST_AUTHORIZATION_RELEASE': paymentChange('release_due', 'release_pending'),
  'system.AUTHORIZATION_RELEASE_CONFIRMED': paymentChange('release_pending', 'released',
    (c) => c.refundStatus === 'full_refund_due' ? 'settled' : c.refundStatus),
  'system.AUTHORIZATION_RELEASE_FAILED': paymentChange('release_pending', 'release_due'),
  'system.FULL_REFUND_SUBMITTED': paymentChange('refund_due', 'refund_pending', 'processing'),
  'system.FULL_REFUND_SETTLED': paymentChange('refund_pending', 'refunded', 'settled'),
  'system.FULL_REFUND_FAILED': paymentChange('refund_pending', 'refund_due', 'full_refund_due'),
};
const recordFault = assign({
  faultRecovery: true, captureBlocked: true, paidClockPaused: true,
  reportedEquipmentConcerns: ({ context }) => context.reportedEquipmentConcerns + 1,
});
const noReplacement = {
  target: 'Ended', actions: assign(({ context }) => ({
    refundStatus: 'full_refund_due', refundScope: context.faultRecovery ? 'whole_transaction' : null,
    endReason: context.faultRecovery ? 'no_fault_replacement' : 'no_pickup_replacement',
    nextTransactionCreditMinutes: context.faultRecovery ? 30 : 0,
    recoveryCreditStatus: context.faultRecovery ? 'due' : 'not_due',
  })),
};
const creditChange = (from, to) => ({
  guard: ({ context }) => context.recoveryCreditStatus === from,
  actions: assign({ recoveryCreditStatus: to }),
});
const recordMedia = (target, field, value) => ({ target, actions: assign({ [field]: value }) });
const pickupStates = {
  Video: {
    description: 'Default: quick ball turn (~5s), or show every Set component.',
    on: {
      'system.PICKUP_VIDEO_UPLOADED': recordMedia('Inspect', 'pickupEvidence', 'video'),
      'renter.USE_PICKUP_PHOTOS': 'Photos',
      'renter.CAMERA_OR_CONNECTION_FAILURE': 'EvidenceHelp',
    },
  },
  Photos: {
    description: 'Guided still photos are the confirmed video fallback.',
    on: {
      'system.PICKUP_PHOTOS_UPLOADED': recordMedia('Inspect', 'pickupEvidence', 'photos'),
      'renter.CAMERA_OR_CONNECTION_FAILURE': 'EvidenceHelp',
    },
  },
  EvidenceHelp: {
    description: 'Pickup evidence failure policy is OPEN; retry or report a problem.',
    on: { 'renter.RETRY_PICKUP_CAPTURE': 'Video' },
  },
  Inspect: {
    description: 'Looks good does not waive the five-minute guarantee; reporting time counts.',
    on: { 'renter.EQUIPMENT_SATISFACTORY': {
      target: '#rental.Active', actions: assign({ captureBlocked: ({ context }) => context.pickupOrigin === 'exchange' }),
      description: 'Initial and recovery-replacement inspection release recovery block; capture still requires accepted final return and inspection expiry. Preference Exchange guarantee policy OPEN.',
    } },
  },
};
export const rentalMachine = createMachine({
  id: 'rental',
  description: 'Initial, Pickup Replacement and Fault Replacement access: five free inspection minutes, then a fresh paid hour in the same Session. Timely reports protect later refund/return. Authorize before unlock; capture only after accepted final return with inspection/entitlement checks.',
  initial: 'Browsing',
  context: ({ input }) => ({
    sessionId: input?.sessionId ?? 'simulation-session',
    returnAssurance: null, outageExactReturnTime: null, outageOverageExcluded: false, outageReturnBillingReview: false,
    returnUnitIsAuxiliary: false, auxiliaryDepositReported: false,
    returnExceptionReason: null, customerReturnTimeRequired: false,
    paidMinutesRemaining: 60, paidClockStarted: false, paidClockPaused: false,
    replacementExtensionReview: null, extensionsAccepted: 0, exchangeUsed: false,
    faultRecovery: false, faultReplacements: 0, refundScope: null,
    nextTransactionCreditMinutes: 0, recoveryCreditStatus: 'not_due',
    accessElapsedSeconds: null, satisfactionReportedAtSeconds: null,
    pickupReplacements: 0, pickupEvidence: null, pickupOrigin: 'initial',
    sourcePodId: null, sourceUnitId: null, returnUnitId: null, returnDestinationKind: null,
    returnAccessAttempt: 0, returnDoorState: 'unknown', returnDoorOpened: false,
    returnUnlockStatus: 'not_requested', returnAccessIssue: null,
    sourceUnlockRetries: 0, returnOpeningRecovery: 'not_started', firstReturnFailureAtSeconds: null,
    returnFailureCompensated: false, refundReason: null, openingFallbackAfterSourceFailure: false,
    returnFailurePending: false, returnPaidClockPausedBeforeFailure: null,
    returnPurpose: null, returnEvidence: null, unitSecured: false,
    completeSetDeclared: false, sessionEnded: false, endReason: null,
    refundStatus: 'not_due', paymentStatus: 'not_authorized', captureBlocked: true, profileReturnExceptions: 0,
    pendingEvidenceReviews: 0, pendingReadinessReviews: 0,
    reportedEquipmentConcerns: 0, readinessOwner: 'Locker team; isolated sites; immediate local help not assumed',
  }),
  on: {
    ...paymentEvents,
    'system.OUTAGE_RETURN_ACCEPTED': {
      target: '.Ended',
      guard: ({ context, event }) => !context.sessionEnded && context.accessElapsedSeconds !== null
        && favorableOutageAssessment({ context, event }),
      actions: assign(({ context }) => ({
        endReason: 'outage_return_assumed', returnEvidence: 'outage_assumption', returnAssurance: 'inferred',
        outageExactReturnTime: null, outageOverageExcluded: true, outageReturnBillingReview: true,
        paidClockPaused: true, returnFailurePending: false, captureBlocked: true,
        pendingReadinessReviews: context.pendingReadinessReviews + 1,
        pendingEvidenceReviews: context.pendingEvidenceReviews + 1,
      })),
      description: 'Trusted Session-specific customer-favorable outage resolution. No media/time proof or volunteer prerequisite; do not manufacture secure-door facts. Preserve refunds; base-charge settlement remains review work.',
    },
    'system.REQUEST_RECOVERY_CREDIT': creditChange('due', 'issuing'),
    'system.RECOVERY_CREDIT_CONFIRMED': creditChange('issuing', 'available'),
    'system.RECOVERY_CREDIT_FAILED': creditChange('issuing', 'due'),
    'sim.ELAPSE_5_MINUTES': advanceAccessClock(300),
    'sim.ELAPSE_1_SECOND': advanceAccessClock(1),
    'operator.COMPLETE_ONE_READINESS_REVIEW': {
      guard: ({ context }) => context.pendingReadinessReviews > 0,
      actions: assign({ pendingReadinessReviews: ({ context }) => context.pendingReadinessReviews - 1 }),
      description: 'Illustrative queue only; readiness criteria and disposition are open.',
    },
    'operator.COMPLETE_ONE_EVIDENCE_REVIEW': {
      guard: ({ context }) => context.pendingEvidenceReviews > 0,
      actions: assign({ pendingEvidenceReviews: ({ context }) => context.pendingEvidenceReviews - 1 }),
      description: 'Retains profile history. Restrictions require a separate misuse assessment.',
    },
  },
  states: {
    Browsing: { on: { 'renter.SELECT_SET': 'Checkout' } },
    Checkout: { description: 'Validate checkout before authorizing the agreed rental amount; no unlock yet.',
      on: { 'system.CHECKOUT_ACCEPTED': 'Authorizing', 'renter.CANCEL_CHECKOUT': 'Cancelled' },
    },
    Authorizing: {
      entry: assign({ paymentStatus: 'authorizing' }),
      on: {
        'system.AUTHORIZATION_CONFIRMED': { target: 'AwaitingAccess', actions: assign({ paymentStatus: 'authorized' }) },
        'system.AUTHORIZATION_FAILED': { target: 'AuthorizationFailed', actions: assign({ paymentStatus: 'not_authorized' }) },
      },
    },
    AuthorizationFailed: { description: 'No unlock. Retry or cancel; provider/authentication details OPEN.',
      on: { 'renter.RETRY_AUTHORIZATION': 'Authorizing', 'renter.CANCEL_CHECKOUT': 'Cancelled' },
    },
    AwaitingAccess: {
      description: 'Website coordinates the assigned pickup door; actual access identifies the supplying Pod/Unit. Door open alone does not prove usable equipment.',
      on: {
        'system.ACCESS_CONFIRMED': { target: 'Pickup', guard: ({ context, event }) => context.paymentStatus === 'authorized' && identifiedAccess({ event }),
          actions: [recordSourceUnit, assign({ accessElapsedSeconds: 0 })] },
        'support.RESOLVE_FAILED_ACCESS': 'Cancelled',
      },
    },
    Pickup: {
      description: 'Five free inspection minutes from initial/Pickup Replacement/Fault Replacement access, then paid time starts. Early Looks good does not start the clock.',
      initial: 'Video', states: pickupStates,
      on: {
        'renter.REPORT_PICKUP_PROBLEM': [satisfactionReport, {
          target: 'LaterProblem',
          description: 'After inspection, unusable/defective equipment follows fault recovery.',
        }],
      },
    },
    SatisfactionChoice: { description: 'Timely report locks eligibility. Choose refund even if stock exists; no countdown to finish returning.',
      on: {
        'renter.CHOOSE_FULL_REFUND': { target: 'Returning', actions: beginReturn('guarantee_refund') },
        'renter.CHOOSE_SAME_EQUIPMENT_REPLACEMENT': { target: 'Returning', actions: beginReturn('pickup_recovery') },
      },
    },
    Active: {
      description: 'paidClockStarted distinguishes free inspection from paid play; elapsed-time events charge only after five minutes. Preference Exchange keeps its deadline.',
      initial: 'Playing',
      on: { 'renter.REPORT_SATISFACTION_PROBLEM': [satisfactionReport, { target: '#rental.LaterProblem' }] },
      states: {
        Playing: {
          on: {
            'sim.PLAY_10_MINUTES': {
              ...advanceAccessClock(600),
              guard: ({ context }) => context.paidMinutesRemaining > 0,
              description: 'Advance ten real minutes; only the part after free inspection uses paid time.',
            },
            'renter.REQUEST_EXTENSION': 'ExtensionPending',
            'renter.REQUEST_EXCHANGE': {
              target: '#rental.Returning', guard: ({ context }) => !context.exchangeUsed,
              actions: beginReturn('exchange'),
            },
            'renter.START_FINAL_RETURN': {
              target: '#rental.Returning', actions: beginReturn('finish'),
            },
            'renter.REPORT_LATER_PROBLEM': [satisfactionReport, { target: '#rental.LaterProblem' }],
          },
        },
        ExtensionPending: {
          on: {
            'system.EXTENSION_ACCEPTED': {
              target: 'Playing', actions: assign({
                paidMinutesRemaining: ({ context }) => context.paidMinutesRemaining + 30,
                extensionsAccepted: ({ context }) => context.extensionsAccepted + 1,
              }),
            },
            'system.EXTENSION_REJECTED': 'Playing',
            'renter.CANCEL_EXTENSION': 'Playing',
          },
        },
      },
    },
    LaterProblem: {
      entry: recordFault,
      description: 'Fault after inspection: return first, then same-equipment replacement with five free minutes and a fresh hour. No stock: whole-transaction refund plus 30-minute next-transaction credit.',
      on: {
        'renter.CHOOSE_SAME_EQUIPMENT_REPLACEMENT': { target: 'Returning', actions: beginReturn('fault_recovery') },
      },
    },
    Returning: {
      description: 'Return to current Set Source Unit; compatible same-Pod fallback if unavailable. Website unlocks the assigned door during capture; observe opening, closure and secure confirmation. First failure pauses paid time; one source retry then fallback. Neither opens: automatic whole-transaction refund/release; custody remains Q05a OPEN.',
      initial: 'Video',
      always: compensateFailedReturn,
      on: {
        ...returnDoorEvents,
        'renter.DEVICE_UNAVAILABLE': {
          target: '.ExceptionDeclaration',
          actions: assign({ returnEvidence: null, completeSetDeclared: false,
            returnExceptionReason: 'device_unavailable', customerReturnTimeRequired: false }),
          description: 'Borrowed-device/no-media return exception; no customer timestamp required. Physical access and secure return remain necessary; no-phone channel is OPEN.',
        },
        'renter.REPORT_LATER_PROBLEM': {
          guard: ({ context }) => !withinGuarantee({ context }) && context.returnPurpose !== 'fault_recovery',
          actions: [recordFault, assign({ returnPurpose: 'fault_recovery' })],
          description: 'Preserve existing return evidence and secured status for fault recovery.',
        },
        'renter.REPORT_SATISFACTION_PROBLEM': {
          // Re-entry saves the current return step in History before choosing a remedy.
          target: '.SatisfactionChoice', reenter: true,
          guard: ({ context }) => withinGuarantee({ context }) && context.satisfactionReportedAtSeconds === null,
          actions: recordSatisfaction,
          description: 'Timely report during return protects eligibility; keep evidence and secured-Unit confirmation.',
        },
      },
      states: {
        History: { type: 'history' },
        SatisfactionChoice: {
          description: 'Choose after a timely report; resume the prior return step without recapturing evidence.',
          on: {
            'system.RETURN_VIDEO_UPLOADED': recordMedia(undefined, 'returnEvidence', 'video'),
            'system.RETURN_PHOTOS_UPLOADED': recordMedia(undefined, 'returnEvidence', 'photos'),
            'renter.CHOOSE_FULL_REFUND': chooseReturnPurpose('guarantee_refund'),
            'renter.CHOOSE_SAME_EQUIPMENT_REPLACEMENT': chooseReturnPurpose('pickup_recovery'),
          },
        },
        Video: {
          on: {
            'system.RETURN_VIDEO_UPLOADED': recordMedia('ReadyForAcceptance', 'returnEvidence', 'video'),
            'renter.USE_RETURN_PHOTOS': 'Photos',
            'renter.CAMERA_OR_CONNECTION_FAILURE': 'ExceptionDeclaration',
          },
        },
        Photos: {
          on: {
            'system.RETURN_PHOTOS_UPLOADED': recordMedia('ReadyForAcceptance', 'returnEvidence', 'photos'),
            'renter.CAMERA_OR_CONNECTION_FAILURE': 'ExceptionDeclaration',
          },
        },
        ExceptionDeclaration: {
          description: 'Camera/connectivity failure; no declaration is assumed.',
          on: { 'renter.DECLARE_COMPLETE_SET_RETURNED': {
            target: 'ReadyForAcceptance',
            actions: assign({ returnEvidence: 'exception', completeSetDeclared: true }),
          } },
        },
        ReadyForAcceptance: {
          description: 'Normal acceptance evidence beyond this demo is open. Exceptions require declaration and secured Unit.',
          on: { 'system.ACCEPT_RETURN': {
            target: '#rental.ReturnAccepted',
            guard: ({ context }) => context.unitSecured && context.returnDoorState === 'closed'
              && context.returnAccessIssue === null && context.returnEvidence !== null
              && (context.returnEvidence !== 'exception' || context.completeSetDeclared),
            actions: [acceptReturn, reportAuxiliaryDeposit],
          } },
        },
      },
    },
    ReturnAccepted: {
      always: [
        { target: 'Ended', guard: ({ context }) => context.returnFailureCompensated,
          actions: assign({ endReason: 'return_after_access_failure' }) },
        { target: 'Ended', guard: ({ context }) => context.returnPurpose === 'guarantee_refund', actions: fullRefund },
        { target: 'FaultReplacement', guard: ({ context }) => context.returnPurpose === 'fault_recovery'
          || (context.returnPurpose === 'pickup_recovery' && context.faultRecovery) },
        { target: 'PickupReplacement', guard: ({ context }) => context.returnPurpose === 'pickup_recovery' },
        { target: 'ExchangePickup', guard: ({ context }) => context.returnPurpose === 'exchange' },
        { target: 'Ended', actions: assign({ endReason: 'final_return', captureBlocked: false }) },
      ],
    },
    PickupReplacement: { description: 'Same Session/Exchange allowance. Actual access starts five free minutes, then a fresh paid hour. Prior Extension accounting remains OPEN.',
      on: {
        'renter.CHOOSE_FULL_REFUND': chooseRefundAfterReturn,
        'system.SAME_EQUIPMENT_AVAILABLE': 'AwaitingReplacementAccess',
        'system.NO_SAME_EQUIPMENT_AVAILABLE': noReplacement,
      },
    },
    FaultReplacement: {
      description: 'Affected Set returned. Same-equipment replacement or whole-transaction refund plus 30-minute next-transaction credit if no stock.',
      on: {
        'renter.CHOOSE_FULL_REFUND': chooseRefundAfterReturn,
        'system.SAME_EQUIPMENT_AVAILABLE': 'AwaitingReplacementAccess',
        'system.NO_SAME_EQUIPMENT_AVAILABLE': noReplacement,
      },
    },
    AwaitingReplacementAccess: { description: 'Timely satisfaction report still permits refund while replacement is available, before taking it.',
      on: {
        'renter.CHOOSE_FULL_REFUND': chooseRefundAfterReturn,
        'system.REPLACEMENT_ACCESS_CONFIRMED': {
          target: 'Pickup', guard: identifiedAccess, actions: [recordSourceUnit, assign({
            pickupEvidence: null, satisfactionReportedAtSeconds: null,
            pickupOrigin: ({ context }) => context.faultRecovery ? 'fault_replacement' : 'pickup_replacement',
            accessElapsedSeconds: 0, captureBlocked: true,
            paidMinutesRemaining: 60, paidClockStarted: false, paidClockPaused: false,
            replacementExtensionReview: ({ context }) => context.extensionsAccepted > 0
              ? { priorMinutes: context.paidMinutesRemaining, extensionsAccepted: context.extensionsAccepted,
                previous: context.replacementExtensionReview } : context.replacementExtensionReview,
            pickupReplacements: ({ context }) => context.pickupReplacements + Number(!context.faultRecovery),
            faultReplacements: ({ context }) => context.faultReplacements + Number(context.faultRecovery),
          })],
        },
        'system.REPLACEMENT_ACCESS_FAILED': [
          { target: 'FaultReplacement', guard: ({ context }) => context.faultRecovery },
          { target: 'PickupReplacement' },
        ],
      },
    },
    ExchangePickup: { description: 'Preference Exchange: time preserved. Consuming allowance on access remains a proposal.',
      on: {
        'system.REPLACEMENT_ACCESS_CONFIRMED': {
          target: 'Pickup', guard: identifiedAccess, actions: [recordSourceUnit, assign({ exchangeUsed: true, pickupEvidence: null, pickupOrigin: 'exchange', satisfactionReportedAtSeconds: null })],
        },
        'support.CLOSE_UNFULFILLED_EXCHANGE': {
          target: 'Ended', actions: assign({ endReason: 'exchange_support_resolution', refundStatus: 'resolution_open' }),
          description: 'Proposed closing resolution; compensation remains open.',
        },
      },
    },
    Ended: { description: 'Session ENDED. Normal accepted final return permits capture; refund-entitled return releases hold or refunds payment. Fault no-stock also owes 30-minute next-transaction credit. Settlement/issuance never reopens it.',
      entry: [assign({ sessionEnded: true }), settleReturnPayment],
    },
    Cancelled: { description: 'No rental proceeds. Release any confirmed hold; asynchronous payment events may still complete.',
      entry: assign({ paymentStatus: ({ context }) => context.paymentStatus === 'authorized' ? 'release_due' : context.paymentStatus }),
    },
  },
});


// Companion Pod model: separate lifetime from all Session actors, including ended Sessions.
// This is an admission contract, not implemented inventory, diagnostics, authorization or persistence.
const matchingPod = ({ context, event }) => typeof context.podId === 'string'
  && context.podId.length > 0 && event.podId === context.podId;
const identifiedRequest = ({ context, event }) => matchingPod({ context, event })
  && typeof event.requestId === 'string' && event.requestId.length > 0;
export const podAdmissionMachine = createMachine({
  id: 'podAdmission',
  description: 'First confirmed Auxiliary Unit return suspends all new rentals. Keep existing returns available. Reopen only after operator diagnostic/service clearance.',
  initial: 'OpenForNewRentals',
  context: ({ input }) => ({ podId: input?.podId ?? 'simulation-pod',
    auxiliaryReturnIds: [], recoveryRevision: 0, diagnosticAttempt: 0, diagnosticMethod: null,
    lastNewRentalDecision: null, lastExistingReturnDecision: null }),
  on: {
    'system.AUXILIARY_RETURN_CONFIRMED': {
      target: '.NewRentalsSuspended',
      guard: ({ context, event }) => matchingPod({ context, event })
        && typeof event.returnId === 'string' && event.returnId.length > 0
        && typeof event.unitId === 'string' && event.unitId.length > 0
        && !context.auxiliaryReturnIds.includes(event.returnId),
      actions: assign(({ context, event }) => ({
        auxiliaryReturnIds: [...context.auxiliaryReturnIds, event.returnId],
        recoveryRevision: context.recoveryRevision + 1, diagnosticMethod: null,
        lastNewRentalDecision: null,
      })),
      description: 'Unique confirmed deposit; suspends admission independently of the customer Session/media/payment. New deposit invalidates an older diagnostic result.',
    },
    'system.REQUEST_NEW_RENTAL': {
      guard: identifiedRequest,
      actions: assign({ lastNewRentalDecision: ({ event }) => ({ requestId: event.requestId, allowed: false }) }),
    },
    'system.REQUEST_EXISTING_RETURN': {
      guard: identifiedRequest,
      actions: assign({ lastExistingReturnDecision: ({ event }) => ({ requestId: event.requestId, allowed: true }) }),
      description: 'Admission suspension does not prohibit existing returns. Actual identity, capacity and door access remain separate checks.',
    },
  },
  states: {
    OpenForNewRentals: {
      on: { 'system.REQUEST_NEW_RENTAL': { guard: identifiedRequest,
        actions: assign({ lastNewRentalDecision: ({ event }) => ({ requestId: event.requestId, allowed: true }) }),
        description: 'Only this suspension gate passes; all normal checkout requirements still apply.',
      } },
    },
    NewRentalsSuspended: {
      description: 'No new rentals; functioning return access remains available. No automatic timeout/reboot/payment reopening.',
      on: { 'operator.START_DIAGNOSTICS': {
        target: 'Diagnosing',
        guard: ({ context, event }) => matchingPod({ context, event }) && ['remote', 'on_site'].includes(event.method),
        actions: assign({ diagnosticMethod: ({ event }) => event.method,
          diagnosticAttempt: ({ context }) => context.diagnosticAttempt + 1 }),
      } },
    },
    Diagnosing: {
      on: {
        'operator.DIAGNOSTICS_FAILED': { target: 'NewRentalsSuspended',
          guard: ({ context, event }) => matchingPod({ context, event }) && event.recoveryRevision === context.recoveryRevision
            && event.diagnosticAttempt === context.diagnosticAttempt,
          actions: assign({ diagnosticMethod: null }),
        },
        'operator.CONFIRM_SERVICE_READY': {
          target: 'OpenForNewRentals',
          guard: ({ context, event }) => matchingPod({ context, event })
            && event.recoveryRevision === context.recoveryRevision && event.diagnosticAttempt === context.diagnosticAttempt
            && event.diagnosticsPassed === true
            && event.serviceReady === true && event.returnCapacityRestored === true,
          actions: assign({ diagnosticMethod: null }),
          description: 'Explicit current operator clearance after intervention. These flags simulate outcomes; exact diagnostics/permissions are not implemented.',
        },
      },
    },
  },
});

// Return UI sketch: recovery operates on the original Session, not the phone owner's rental.
// It grants no real door permission and does not implement identity verification.
export const returnDeviceRecoveryMachine = createMachine({
  id: 'returnDeviceRecovery', initial: 'PhysicalInstructions',
  description: 'Device unavailable: use another phone, or read physical no-phone instructions. No media/customer timestamp requirement. Return without a phone or Pod power is required; the physical mechanism remains OPEN.',
  context: { recoveryAttempt: 0, recoveredSessionId: null, mediaRequired: false, customerReturnTimeRequired: false },
  states: {
    PhysicalInstructions: {
      description: 'Readable signage explains the borrowed-phone route and media/timing relief; a QR alone is insufficient.',
      on: { 'renter.USE_BORROWED_PHONE': 'IdentifyOriginalSession', 'renter.NO_USABLE_PHONE': 'NoPhoneAccessUnresolved' },
    },
    IdentifyOriginalSession: {
      entry: assign({ recoveryAttempt: ({ context }) => context.recoveryAttempt + 1, recoveredSessionId: null }),
      description: 'Return-only recovery UI. Do not require approval solely on the broken device; identity mechanism remains OPEN.',
      on: {
        'system.SESSION_RECOVERY_VERIFIED': {
          target: 'ReturnAccessReady',
          guard: ({ context, event }) => event.attempt === context.recoveryAttempt
            && event.verified === true && typeof event.sessionId === 'string' && event.sessionId.length > 0,
          actions: assign({ recoveredSessionId: ({ event }) => event.sessionId }),
        },
        'system.SESSION_RECOVERY_FAILED': { target: 'RecoveryHelp',
          guard: ({ context, event }) => event.attempt === context.recoveryAttempt },
        'renter.NO_USABLE_PHONE': 'NoPhoneAccessUnresolved',
      },
    },
    RecoveryHelp: {
      description: 'Try recovery again; no promise of immediate staff. Do not create a new rental or charge the borrowed-phone owner.',
      on: { 'renter.RETRY_RECOVERY': 'IdentifyOriginalSession', 'renter.NO_USABLE_PHONE': 'NoPhoneAccessUnresolved' },
    },
    ReturnAccessReady: {
      description: 'Resume the identified existing Session return, using DEVICE_UNAVAILABLE if media is unavailable; complete-Set declaration and secure physical acceptance remain required. Receipt delivery to original phone is not a prerequisite.',
    },
    NoPhoneAccessUnresolved: {
      description: 'Required: return without a phone or Pod power, with customer-favorable state/time assumptions. Physical deposit method remains unselected/unvalidated. Later reconciliation is modeled separately; no fabricated unlock.',
      on: { 'renter.USE_BORROWED_PHONE': 'IdentifyOriginalSession' },
    },
  },
});


// Outage aftercare, not a power-independent physical deposit implementation.
// No contents observer, recovery timestamp or exact customer timestamp is required for fair resolution.
export const powerlessReturnRecoveryMachine = createMachine({
  id: 'powerlessReturnRecovery', initial: 'AwaitingRecovery',
  description: 'Powerless/phoneless return is a required physical capability, still unvalidated. Reconcile unknown state/time fairly; no outage-caused uncertain extra charge. Pod online is not proof of return.',
  context: ({ input }) => ({ podId: input?.podId ?? 'simulation-pod',
    sessionId: input?.sessionId ?? 'simulation-session', podOnline: false,
    contentsObservation: null, customerResolved: false, returnAssurance: null,
    exactReturnTime: null, uncertainOverageCharge: 0, inventoryReviewRequired: true,
  }),
  on: {
    'observer.REPORT_CONTENTS': {
      guard: ({ context, event }) => matchingPod({ context, event })
        && typeof event.unitId === 'string' && event.unitId.length > 0 && typeof event.equipmentPresent === 'boolean',
      actions: assign({ contentsObservation: ({ event }) => ({ unitId: event.unitId, equipmentPresent: event.equipmentPresent }) }),
      description: 'Optional supporting observation; does not establish Session ownership, time, readiness, diagnostic clearance or reward eligibility.',
    },
    'operator.ACCEPT_OUTAGE_RETURN': {
      target: '.CustomerResolved',
      guard: ({ context, event }) => !context.customerResolved && favorableOutageAssessment({ context, event }),
      actions: [assign({ customerResolved: true, returnAssurance: 'inferred', exactReturnTime: null }),
        enqueueActions(({ context, event, enqueue }) => enqueue.emit({
          type: 'system.OUTAGE_RETURN_ACCEPTED', podId: context.podId, sessionId: context.sessionId,
          outageConfirmed: true, customerFavorable: true, basis: event.basis,
        })),
      ],
      description: 'Trusted service assessment may resolve without exact time, media, a volunteer or power recovery. Preserve the distinction between accepted inference and verified inventory.',
    },
  },
  states: {
    AwaitingRecovery: {
      description: 'Offline physical return may have happened; no live deposit detection is assumed. Customer must not wait for recovery at the Pod.',
      on: { 'system.POD_ONLINE': { target: 'Reconciling', guard: matchingPod,
        actions: assign({ podOnline: true }) } },
    },
    Reconciling: {
      description: 'Online status alone does not reveal contents or return time. Use available evidence and customer-favorable assumptions; no automatic penalty while reconciling.',
    },
    CustomerResolved: {
      description: 'Customer return resolved; unknown exact time remains unknown. Inventory/readiness and original-charge review remain separate. Later ambiguous/missing contents do not automatically reverse the resolution.',
      on: { 'system.POD_ONLINE': { guard: matchingPod, actions: assign({ podOnline: true }) } },
    },
  },
});


// Optional helper reward. Offer amount is explicit input; no product amount or redemption method is chosen here.
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const matchingHelperCheck = ({ context, event }) => event.checkId === context.checkId
  && event.helperId === context.helperId && event.podId === context.podId && event.unitId === context.unitId;
export const helperCheckCreditMachine = createMachine({
  id: 'helperCheckCredit', initial: 'OfferSetup',
  description: 'Optional requested check: same fixed offered time credit for a completed present or missing report. Independent of customer resolution, diagnostics and admission. Amount/redemption/access details remain OPEN.',
  context: { checkId: null, helperId: null, podId: null, unitId: null,
    offeredMinutes: null, equipmentPresent: null, creditStatus: 'not_due', issuanceAttempt: 0 },
  states: {
    OfferSetup: {
      on: { 'system.CONFIGURE_HELPER_OFFER': {
        target: 'Offered',
        guard: ({ event }) => [event.checkId, event.helperId, event.podId, event.unitId].every(nonempty)
          && Number.isSafeInteger(event.minutes) && event.minutes > 0,
        actions: assign(({ event }) => ({ checkId: event.checkId, helperId: event.helperId,
          podId: event.podId, unitId: event.unitId, offeredMinutes: event.minutes })),
        description: 'Trusted offer with explicit target/helper and visible fixed minutes. Test amounts are illustrative, not an adopted product amount.',
      } },
    },
    Offered: {
      on: {
        'helper.ACCEPT_CHECK': { target: 'Checking', guard: matchingHelperCheck },
        'helper.DECLINE_CHECK': { target: 'Declined', guard: matchingHelperCheck },
      },
    },
    Checking: {
      description: "Viewing/access method must be safe and validated. No photo requirement or permission to open another customer's occupied Unit is granted here. Incomplete-check policy OPEN.",
      on: {
        'helper.DECLINE_CHECK': { target: 'Declined', guard: matchingHelperCheck },
        'helper.REPORT_CONTENTS': {
        target: 'CreditDue',
        guard: ({ context, event }) => matchingHelperCheck({ context, event }) && typeof event.equipmentPresent === 'boolean',
        actions: assign({ equipmentPresent: ({ event }) => event.equipmentPresent, creditStatus: 'due' }),
        description: 'Both true and false earn exactly the offered credit. Completion does not accept the original return or establish its timestamp.',
      } },
    },
    CreditDue: {
      on: { 'system.REQUEST_HELPER_CREDIT': {
        target: 'Issuing', guard: matchingHelperCheck,
        actions: assign({ creditStatus: 'issuing', issuanceAttempt: ({ context }) => context.issuanceAttempt + 1 }),
      } },
    },
    Issuing: {
      on: {
        'system.HELPER_CREDIT_CONFIRMED': { target: 'Credited',
          guard: ({ context, event }) => matchingHelperCheck({ context, event }) && event.attempt === context.issuanceAttempt,
          actions: assign({ creditStatus: 'available' }),
        },
        'system.HELPER_CREDIT_FAILED': { target: 'CreditDue',
          guard: ({ context, event }) => matchingHelperCheck({ context, event }) && event.attempt === context.issuanceAttempt,
          actions: assign({ creditStatus: 'due' }),
        },
      },
    },
    Credited: { description: 'One offered credit entitlement recorded; duplicates do not create more. Redemption rules/account integration remain OPEN.' },
    Declined: { description: "No check or credit. No change to the helper's own rental, original customer resolution or Pod admission." },
  },
});
