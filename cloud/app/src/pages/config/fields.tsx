import { useState, type ReactNode } from 'react';
import { Button, Input, TextArea } from '@readysetcloud/ui';

/** Text the person types, kept as typed, with the parsed value handed up. */
export function ParsedText({
  value,
  parse,
  format,
  onChange,
  multiline,
  ...props
}: {
  value: string[];
  parse: (text: string) => string[];
  format: (v: string[]) => string;
  onChange: (v: string[]) => void;
  multiline?: boolean;
  label: string;
  hint?: string;
  error?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => format(value));
  const change = (t: string) => {
    setText(t);
    onChange(parse(t));
  };
  return multiline ? (
    <TextArea {...props} className="font-mono" rows={Math.max(3, text.split('\n').length + 1)} value={text} onChange={(e) => change(e.target.value)} />
  ) : (
    <Input {...props} value={text} onChange={(e) => change(e.target.value)} />
  );
}

export function PromptField({ label, value, onChange, onReset, error, packaged }: { label: string; value: string; onChange: (v: string) => void; onReset: () => void; error?: string; packaged: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <TextArea label={label} className="min-h-48 font-mono text-sm" rows={10} value={value} error={error} onChange={(e) => onChange(e.target.value)} />
      <div>
        <Button variant="ghost" size="sm" type="button" disabled={packaged} onClick={onReset}>
          {packaged ? 'Packaged prompt' : 'Reset to the packaged prompt'}
        </Button>
      </div>
    </div>
  );
}

export function Check({ checked, onChange, disabled, children, testId }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode; testId?: string }) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm text-error">{message}</p> : null;
}
