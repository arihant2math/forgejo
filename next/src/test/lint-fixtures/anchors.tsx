// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lint fixture for tokens/no-restyle spreads (lint/lint.test.ts): exactly the lines marked "reported" are reported.

import {AnchoredOverlay, Button} from '@primer/react';
import type {HTMLAttributes} from 'react';

type Props = HTMLAttributes<HTMLElement>;

export const common = {renderAnchor: (props: Props) => <Button {...props}>A renderAnchor property</Button>};

export const Callback = () => <AnchoredOverlay open={false} renderAnchor={(props) => <Button {...props}>Anchor</Button>}>…</AnchoredOverlay>;

export const Literal = () => <Button {...{type: 'button' as const}}>Literal</Button>;

export const Other = ({rest}: {rest: Props}) => <AnchoredOverlay open={false} renderAnchor={() => <Button {...rest}>Not its parameter</Button>}>…</AnchoredOverlay>; // reported

export const Picked = () => <AnchoredOverlay open={false} renderAnchor={({id, ...props}) => <Button id={id} {...props}>Destructured</Button>}>…</AnchoredOverlay>; // reported

export const Plain = ({rest}: {rest: Props}) => <Button {...rest}>A variable</Button>; // reported

export const Mapped = ({all}: {all: Props[]}) => all.map((props) => <Button key={props.id} {...props}>Not an anchor</Button>); // reported

export const Restyled = () => <Button {...{className: 'bg-danger-emphasis'}}>Restyled</Button>; // reported
