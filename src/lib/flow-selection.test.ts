import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from './store';
import { defaultMachineCode } from './machine';

beforeEach(() => {
  appStore.trigger.sourceFileChanged({ code: defaultMachineCode, id: '', name: '' });
});

describe('flow selection', () => {
  it.each(['rental', 'podAdmission', 'returnDeviceRecovery', 'powerlessReturnRecovery', 'helperCheckCredit'])('shows %s without replacing the source', (id) => {
    const code = defaultMachineCode + '\n// preserved draft\n';
    appStore.trigger.updateFromCode({ code });
    appStore.trigger.selectMachine({ id });
    const context = appStore.getSnapshot().context;
    expect(context.machine?.id).toBe(id);
    expect(context.graph?.nodes.some((node) => node.id === id)).toBe(true);
    expect(context.code).toBe(code);
    expect(context.error).toBeNull();
  });

  it('clears simulation state when switching flows', () => {
    appStore.trigger.startSim();
    expect(appStore.getSnapshot().context.mode).toBe('sim');
    appStore.trigger.selectMachine({ id: 'powerlessReturnRecovery' });
    const context = appStore.getSnapshot().context;
    expect(context.mode).toBe('view');
    expect(context.simMachine).toBeNull();
    expect(context.simEvents).toEqual([]);
    expect(context.simActiveIds.size).toBe(0);
    expect(context.machine?.id).toBe('powerlessReturnRecovery');
  });

  it('preserves selection across code edits and rejects unknown selections', () => {
    appStore.trigger.selectMachine({ id: 'podAdmission' });
    appStore.trigger.updateFromCode({ code: defaultMachineCode + '\n' });
    expect(appStore.getSnapshot().context.machine?.id).toBe('podAdmission');
    appStore.trigger.selectMachine({ id: 'missing' });
    expect(appStore.getSnapshot().context.machine?.id).toBe('podAdmission');
  });
});
