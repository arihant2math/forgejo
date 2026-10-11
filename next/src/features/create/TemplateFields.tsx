// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {CommandPopover, Select} from '../../ui/index.ts';
import {MarkdownField, MarkdownPreview} from '../editor/Composer.tsx';
import {type FormValues, type TemplateField, optionLabel, optionVisible, visible} from './templates.ts';
import {Button, Checkbox, FormControl, TextInput, Textarea} from '@primer/react';

export const TemplateFields = observer(function TemplateFields({fields, values, missing, repoId, onChange}: {
  fields: TemplateField[]; values: FormValues; missing: string[]; repoId: number;
  onChange: (id: string, value: string | number[]) => void;
}) {
  return <>{fields.filter((f) => visible(f, 'form')).map((f, index) => {
    const a = f.attributes;
    const id = `issue-form-${String(index)}`;
    const errorId = `${id}-error`;
    const invalid = missing.includes(f.id);
    const text = typeof values[f.id] === 'string' ? values[f.id] as string : '';
    const selected = Array.isArray(values[f.id]) ? values[f.id] as number[] : [];
    const options = a.options ?? [];
    const setText = (value: string) => { onChange(f.id, value); };
    const toggle = (i: number) => { onChange(f.id, selected.includes(i) ? selected.filter((v) => v !== i) : [...selected, i]); };
    if (f.type === 'markdown') return <MarkdownPreview key={id} text={a.value ?? ''} repoId={repoId}/>;

    let control: ReactNode;
    if (f.type === 'input') {
      control = <TextInput id={id} value={text} placeholder={a.placeholder} aria-describedby={errorId} onChange={(e) => { setText(e.target.value); }} {...(invalid ? {validationStatus: 'error' as const} : {})}/>;
    } else if (f.type === 'textarea') {
      control = a.render ?
        <Textarea id={id} value={text} placeholder={a.placeholder} aria-describedby={errorId} onChange={(e) => { setText(e.target.value); }} block {...(invalid ? {validationStatus: 'error' as const} : {})} rows={6}/> :
        <MarkdownField repoId={repoId} label={a.label ?? ''} value={text} placeholder={a.placeholder}
          invalid={invalid} describedBy={errorId} onChange={setText}/>;
    } else if (f.type === 'dropdown' && !a.multiple) {
      control = <Select id={id} aria-describedby={errorId} invalid={invalid} value={selected.length ? String(selected[0]) : ''}
        onValueChange={(v) => { onChange(f.id, v === '' ? [] : [Number(v)]); }}
        options={[{value: '', label: 'Choose an option…'}, ...options.map((o, i) => ({value: String(i), label: optionLabel(o)}))]}/>;
    } else if (f.type === 'dropdown') {
      control = <CommandPopover label={a.label ?? 'Options'} placeholder="Find an option…"
        trigger={<Button type="button" id={id} aria-label={a.label} aria-invalid={invalid} aria-describedby={errorId}>
          {selected.length ? selected.map((i) => optionLabel(options[i] ?? '')).join(', ') : 'Choose options…'}
        </Button>}
        options={options.map((o, i) => ({value: String(i), label: optionLabel(o), checked: selected.includes(i), keepOpen: true,
          onSelect: () => { toggle(i); }}))}/>;
    } else {
      control = <div id={id} role="group" aria-label={a.label} aria-invalid={invalid} aria-describedby={errorId} className="flex flex-col gap-1">
        {options.map((option, i) => !optionVisible(option, 'form') ? null :
          <FormControl key={i}><Checkbox checked={selected.includes(i)} onChange={() => { toggle(i); }}/><FormControl.Label>{optionLabel(option)}</FormControl.Label></FormControl>)}
      </div>;
    }
    return <FormControl key={id} id={id}><FormControl.Label>{a.label ?? ''}</FormControl.Label>{control}<FormControl.Caption>{a.description}</FormControl.Caption>{(invalid ? 'Complete this required field.' : undefined) && <FormControl.Validation variant="error">{invalid ? 'Complete this required field.' : undefined}</FormControl.Validation>}</FormControl>;
  })}</>;
});
