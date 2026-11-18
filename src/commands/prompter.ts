import * as clack from '@clack/prompts';
import { CancelledError } from './errors.js';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SingleOpts<T> {
  message: string;
  options: Choice<T>[];
  initialValue?: T;
}

export interface MultiOpts<T> {
  message: string;
  options: Choice<T>[];
  initialValues?: T[];
  required?: boolean;
}

/**
 * The interactive surface `updraft configure` uses. The default implementation
 * wraps @clack/prompts; tests script answers with a fake. Every prompt throws
 * CancelledError when the user cancels (Ctrl+C / Esc).
 */
export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** Searchable multi-select (type to filter). */
  searchMultiselect<T>(o: MultiOpts<T>): Promise<T[]>;
  /** Searchable single select (type to filter). */
  searchSelect<T>(o: SingleOpts<T> & { placeholder?: string }): Promise<T>;
  select<T>(o: SingleOpts<T>): Promise<T>;
  multiselect<T>(o: MultiOpts<T>): Promise<T[]>;
  text(o: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(o: { message: string; initialValue?: boolean }): Promise<boolean>;
  /** Run fn with a spinner. */
  spin<T>(message: string, fn: () => Promise<T>): Promise<T>;
}

function unwrap<T>(v: T): Exclude<T, symbol> {
  if (clack.isCancel(v)) {
    clack.cancel('Cancelled.');
    throw new CancelledError();
  }
  return v as Exclude<T, symbol>;
}

// clack's Option<T> is a conditional type; our Choice<T> satisfies both branches.
type Opts = never;

function contains(search: string, opt: { label?: string; hint?: string; value: unknown }): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return `${opt.label ?? String(opt.value)} ${opt.hint ?? ''}`.toLowerCase().includes(term);
}

export function createClackPrompter(): Prompter {
  return {
    intro: (t) => clack.intro(t),
    outro: (m) => clack.outro(m),
    note: (b, t) => clack.note(b, t),
    info: (m) => clack.log.info(m),
    warn: (m) => clack.log.warn(m),
    async searchMultiselect<T>(o: MultiOpts<T>) {
      return unwrap(
        await clack.autocompleteMultiselect<T>({
          message: o.message,
          options: o.options as Opts,
          initialValues: o.initialValues,
          required: o.required ?? false,
          placeholder: 'Type to search',
          maxItems: 12,
          filter: contains as Opts,
        }),
      );
    },
    async searchSelect<T>(o: SingleOpts<T> & { placeholder?: string }) {
      return unwrap(
        await clack.autocomplete<T>({
          message: o.message,
          options: o.options as Opts,
          initialValue: o.initialValue,
          placeholder: o.placeholder ?? 'Type to search',
          maxItems: 10,
          filter: contains as Opts,
        }),
      );
    },
    async select<T>(o: SingleOpts<T>) {
      return unwrap(await clack.select<T>({ message: o.message, options: o.options as Opts, initialValue: o.initialValue }));
    },
    async multiselect<T>(o: MultiOpts<T>) {
      return unwrap(
        await clack.multiselect<T>({
          message: o.message,
          options: o.options as Opts,
          initialValues: o.initialValues,
          required: o.required ?? false,
        }),
      );
    },
    async text(o) {
      const validate = o.validate;
      return unwrap(
        await clack.text({
          message: o.message,
          placeholder: o.placeholder,
          initialValue: o.initialValue,
          defaultValue: o.defaultValue,
          validate: validate ? (v) => validate(v ?? '') : undefined,
        }),
      );
    },
    async confirm(o) {
      return unwrap(await clack.confirm({ message: o.message, initialValue: o.initialValue ?? true }));
    },
    async spin(message, fn) {
      const s = clack.spinner();
      s.start(message);
      try {
        const result = await fn();
        s.stop(message);
        return result;
      } catch (err) {
        s.stop(`${message} (failed)`);
        throw err;
      }
    },
  };
}
