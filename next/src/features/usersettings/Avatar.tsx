// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {TrashIcon, UploadIcon} from '@primer/octicons-react';
import {Avatar, Button as PrimerButton} from '@primer/react';
import {SkeletonAvatar} from '@primer/react/experimental';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {useOfflineReason} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {
deleteAvatar,
uploadAvatar
} from './data.ts';
import {FormSection} from './form.tsx';
import {
AVATAR_MAX,
toBase64
} from './payload.ts';
import {failure} from './SettingsParts.tsx';

export const AvatarEditor = observer(function AvatarEditor() {
  const app = useApp();
  const {data, userId} = useSession();
  const user = data.pool.model('User').get(userId);
  const url = user?.get('avatar_url');
  const login = user?.get('login') ?? '';
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{url: string; was: string | undefined} | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const offline = useOfflineReason('Changing your picture');
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);
  const shown = preview && preview.was === url ? preview.url : url;
  const upload = (file: File) => {
    setError(undefined);
    if (!file.type.startsWith('image/')) {
      setError('Choose an image (PNG, JPEG, GIF or WebP).');
      return;
    }
    if (file.size > AVATAR_MAX) {
      setError('This picture is too large.');
      return;
    }
    setBusy(true);
    file.arrayBuffer().then((buf) => {
      setPreview({url: URL.createObjectURL(file), was: url});
      return uploadAvatar(app, toBase64(new Uint8Array(buf)));
    }).then(() => {
      notify(app, {tone: 'success', title: 'Picture changed'});
    }, (err: unknown) => {
      setPreview(undefined);
      setError(failure(err));
    }).finally(() => {
      setBusy(false);
    });
  };
  const remove = () => {
    setError(undefined);
    setBusy(true);
    deleteAvatar(app).then(() => {
      setPreview(undefined);
      notify(app, {tone: 'success', title: 'Picture removed'});
    }, (err: unknown) => {
      setError(failure(err));
    }).finally(() => {
      setBusy(false);
    });
  };
  return (
    <FormSection title="Profile picture">
      <div className="flex flex-wrap items-center gap-4">
        {shown ? <Avatar size={96} alt={login} src={shown}/> : <SkeletonAvatar size={96}/>}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <PrimerButton size="small" leadingVisual={UploadIcon} type="button" disabled={busy || Boolean(offline)} onClick={() => input.current?.click()}>{busy ? 'Saving…' : 'Upload a picture'}</PrimerButton>
            <PrimerButton size="small" variant="invisible" leadingVisual={TrashIcon} type="button" disabled={busy || Boolean(offline)} onClick={remove}>Remove</PrimerButton>
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <p className="text-sm text-muted">{offline ?? 'A square picture looks best.'}</p>}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) upload(file);
        }}/>
      </div>
    </FormSection>
  );
});
