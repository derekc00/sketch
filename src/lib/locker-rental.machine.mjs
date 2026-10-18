import { createMachine, assign } from 'xstate';
// DESIGN PROTOTYPE — confirmed product decisions, 2026-10-18.
// Guided video/photo fallback; return-first recovery preserves Exchange/time.
// Return exceptions end Sessions with profile/review flags; our team owns readiness.
// SIMULATION: play-time budget, not a real clock; normal clock-start is open.
// Five-minute guarantee from actual access; timely report protects later return.
// Authorize before access; capture after the window with no pending recovery.
// Release uncaptured holds / refund captured payments after eligible accepted return.
// No real media, locks, payment, identities, evidence checks or permissions.
const beginReturn = (purpose) => assign({
  returnPurpose: purpose, returnEvidence: null,
  captureBlocked: ({ context }) => purpose === 'finish' ? context.captureBlocked : true,
  unitSecured: false, completeSetDeclared: false,
});
const chooseReturnPurpose = (purpose) => [
  { target: 'ReadyForAcceptance', guard: ({ context }) => context.returnEvidence !== null,
    actions: assign({ returnPurpose: purpose }) },
  { target: 'History', actions: assign({ returnPurpose: purpose }) },
];
const acceptReturn = assign(({ context }) => ({
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
  captureBlocked: true,
});
const satisfactionReport = {
  target: '#rental.SatisfactionChoice', guard: withinGuarantee,
  actions: recordSatisfaction,
};
const advanceAccessClock = (seconds) => ({
  guard: ({ context }) => context.accessElapsedSeconds !== null,
  actions: assign({ accessElapsedSeconds: ({ context }) => context.accessElapsedSeconds + seconds }),
});
const fullRefund = assign({ refundStatus: 'full_refund_due', endReason: 'satisfaction_guarantee' });
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
const paymentEvents = {
  'system.REQUEST_CAPTURE': {
    guard: ({ context }) => context.paymentStatus === 'authorized'
      && context.accessElapsedSeconds > 300 && !context.captureBlocked
      && context.satisfactionReportedAtSeconds === null && context.refundStatus === 'not_due',
    actions: assign({ paymentStatus: 'capture_pending' }),
    description: 'Server-side decision; no timely report, qualifying return or unresolved pickup recovery.',
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
      target: '#rental.Active', actions: assign({ captureBlocked: ({ context }) => context.pickupOrigin !== 'initial' }),
      description: 'Replacement inspection-window policy OPEN; its capture stays blocked pending that decision.',
    } },
  },
};
export const rentalMachine = createMachine({
  id: 'rental',
  description: 'Five-minute satisfaction guarantee from actual access. Choose full refund even if replacement exists; return may finish later. Authorize before unlock; capture after the window with recovery checks.',
  initial: 'Browsing',
  context: {
    paidMinutesRemaining: 60, extensionsAccepted: 0, exchangeUsed: false,
    accessElapsedSeconds: null, satisfactionReportedAtSeconds: null,
    pickupReplacements: 0, pickupEvidence: null, pickupOrigin: 'initial',
    returnPurpose: null, returnEvidence: null, unitSecured: false,
    completeSetDeclared: false, sessionEnded: false, endReason: null,
    refundStatus: 'not_due', paymentStatus: 'not_authorized', captureBlocked: true, profileReturnExceptions: 0,
    pendingEvidenceReviews: 0, pendingReadinessReviews: 0,
    reportedEquipmentConcerns: 0, readinessOwner: 'Locker team; local help allowed',
  },
  on: {
    ...paymentEvents,
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
      on: {
        'system.ACCESS_CONFIRMED': { target: 'Pickup', guard: ({ context }) => context.paymentStatus === 'authorized',
          actions: assign({ accessElapsedSeconds: 0 }) },
        'support.RESOLVE_FAILED_ACCESS': 'Cancelled',
      },
    },
    Pickup: {
      description: 'Record condition and check the equipment on receipt.',
      initial: 'Video', states: pickupStates,
      on: {
        'renter.REPORT_PICKUP_PROBLEM': [satisfactionReport, {
          target: 'Returning', actions: [beginReturn('pickup_recovery'),
            assign({ reportedEquipmentConcerns: ({ context }) => context.reportedEquipmentConcerns + 1 })],
          description: 'Outside guarantee: pickup recovery remains; replacement-window rules OPEN.',
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
      initial: 'Playing',
      on: { 'renter.REPORT_SATISFACTION_PROBLEM': [satisfactionReport, { target: '#rental.LaterProblem' }] },
      states: {
        Playing: {
          on: {
            'sim.PLAY_10_MINUTES': {
              guard: ({ context }) => context.paidMinutesRemaining >= 10,
              actions: assign({ paidMinutesRemaining: ({ context }) => context.paidMinutesRemaining - 10,
                accessElapsedSeconds: ({ context }) => context.accessElapsedSeconds + 600 }),
              description: 'Manual play only; recovery time never decrements this budget.',
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
      entry: assign({ captureBlocked: true }),
      description: 'Help remains after five minutes; later-defect remedies are OPEN. Expiry never ends a Session or marks equipment satisfactory.',
      on: {
        'renter.CONTINUE_PLAYING': 'Active',
        'renter.START_FINAL_RETURN': { target: 'Returning', actions: beginReturn('finish') },
      },
    },
    Returning: {
      description: 'Used for final return, Exchange and pickup recovery; purpose decides what follows.',
      initial: 'Video',
      on: {
        'system.RETURN_UNIT_SECURED': { actions: assign({ unitSecured: true }) },
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
            guard: ({ context }) => context.unitSecured && (context.returnEvidence !== 'exception' || context.completeSetDeclared),
            actions: acceptReturn,
          } },
        },
      },
    },
    ReturnAccepted: {
      always: [
        { target: 'Ended', guard: ({ context }) => context.returnPurpose === 'guarantee_refund', actions: fullRefund },
        { target: 'PickupReplacement', guard: ({ context }) => context.returnPurpose === 'pickup_recovery' },
        { target: 'ExchangePickup', guard: ({ context }) => context.returnPurpose === 'exchange' },
        { target: 'Ended', actions: assign({ endReason: 'final_return' }) },
      ],
    },
    PickupReplacement: { description: 'First Set returned; same-kind replacement, no Exchange or playing-time cost.',
      on: {
        'renter.CHOOSE_FULL_REFUND': chooseRefundAfterReturn,
        'system.SAME_EQUIPMENT_AVAILABLE': 'AwaitingReplacementAccess',
        'system.NO_SAME_EQUIPMENT_AVAILABLE': {
          target: 'Ended', actions: assign({ refundStatus: 'full_refund_due', endReason: 'no_pickup_replacement' }),
        },
      },
    },
    AwaitingReplacementAccess: { description: 'Timely satisfaction report still permits refund while replacement is available, before taking it.',
      on: {
        'renter.CHOOSE_FULL_REFUND': chooseRefundAfterReturn,
        'system.REPLACEMENT_ACCESS_CONFIRMED': {
          target: 'Pickup', actions: assign({
            pickupEvidence: null, pickupOrigin: 'pickup_replacement', satisfactionReportedAtSeconds: null,
            pickupReplacements: ({ context }) => context.pickupReplacements + 1,
          }),
        },
        'system.REPLACEMENT_ACCESS_FAILED': 'PickupReplacement',
      },
    },
    ExchangePickup: { description: 'Preference Exchange: time preserved. Consuming allowance on access remains a proposal.',
      on: {
        'system.REPLACEMENT_ACCESS_CONFIRMED': {
          target: 'Pickup', actions: assign({ exchangeUsed: true, pickupEvidence: null, pickupOrigin: 'exchange', satisfactionReportedAtSeconds: null }),
        },
        'support.CLOSE_UNFULFILLED_EXCHANGE': {
          target: 'Ended', actions: assign({ endReason: 'exchange_support_resolution', refundStatus: 'resolution_open' }),
          description: 'Proposed closing resolution; compensation remains open.',
        },
      },
    },
    Ended: { description: 'Session ENDED. Eligible return: release uncaptured authorization or refund captured payment. Pending results never reopen it.',
      entry: [assign({ sessionEnded: true }), settleReturnPayment],
    },
    Cancelled: { description: 'No rental proceeds. Release any confirmed hold; asynchronous payment events may still complete.',
      entry: assign({ paymentStatus: ({ context }) => context.paymentStatus === 'authorized' ? 'release_due' : context.paymentStatus }),
    },
  },
});
