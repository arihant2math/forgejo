// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Dialog, FormControl, TextInput} from '@primer/react';
import {useRef, useState} from 'react';

/** Saved views are local: submitting needs neither a request nor a loading state. */
export function ViewNameDialog({title, description, initial = '', onClose, onSave}: {
  title: string; description?: string; initial?: string; onClose: () => void; onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const save = () => {
    if (!name.trim()) return;
    onClose();
    if (name.trim() !== initial) onSave(name.trim());
  };
  return <Dialog width="medium" title={title} {...(description ? {subtitle: description} : {})} onClose={onClose} initialFocusRef={inputRef}
    footerButtons={[{content: 'Cancel', onClick: onClose}, {content: 'Save', buttonType: 'primary', disabled: !name.trim(), onClick: save}]}>
    <form onSubmit={(event) => {event.preventDefault(); save();}}>
      <FormControl required>
        <FormControl.Label>View name</FormControl.Label>
        <TextInput ref={inputRef} block maxLength={80} value={name} aria-label="View name"
          onFocus={(event) => {event.currentTarget.select();}}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault(); save();}
          }}
          onChange={(event) => {setName(event.target.value);}}/>
      </FormControl>
    </form>
  </Dialog>;
}
