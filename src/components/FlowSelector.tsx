import { useMemo } from 'react';
import { useSelector } from '@xstate/store-react';
import { detectFormat, parseCode } from '@/lib/machine';
import { appStore } from '@/lib/store';

const flowLabels: Record<string, string> = {
  rental: 'Rental journey',
  helperCheckCredit: 'Helper credit',
  podAdmission: 'Pod availability',
  returnDeviceRecovery: 'Phone unavailable',
  powerlessReturnRecovery: 'Powerless return',
};

export function FlowSelector() {
  const code = useSelector(appStore, (state) => state.context.code);
  const selectedId = useSelector(appStore, (state) => state.context.machine?.id);
  const flows = useMemo(() => {
    const result = parseCode(code, detectFormat(code));
    return result.error ? [] : result.machines;
  }, [code]);
  if (flows.length < 2) return null;
  return (
    <select
      aria-label="Flow"
      value={selectedId ?? flows[0].id}
      onChange={(event) => appStore.trigger.selectMachine({ id: event.target.value })}
      className="max-w-40 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
    >
      {flows.map((flow) => (
        <option key={flow.id} value={flow.id}>{flowLabels[flow.id] ?? flow.id}</option>
      ))}
    </select>
  );
}
