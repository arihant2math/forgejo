// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"slices"

	"forgejo.org/services/livesync/protocol"
)

// modelKinds lists, per model, the kinds of groups its entities can be
// placed in (the placement rules of services/livesync/materialize, B3/B4
// notes): a re-bootstrap marker for a model concerns the subscriptions to
// groups of these kinds only. A model missing here concerns every group
// (TestModelKindsCoverModels keeps the table complete).
var modelKinds = map[protocol.Model][]string{
	protocol.ModelRepository:    {protocol.GroupPrefixRepo},
	protocol.ModelUser:          {protocol.GroupPrefixOrg, protocol.GroupPrefixProfile, protocol.GroupPrefixProfiles},
	protocol.ModelOrgUser:       {protocol.GroupPrefixOrg},
	protocol.ModelTeam:          {protocol.GroupPrefixOrg},
	protocol.ModelTeamUser:      {protocol.GroupPrefixOrg},
	protocol.ModelTeamRepo:      {protocol.GroupPrefixOrg},
	protocol.ModelTeamUnit:      {protocol.GroupPrefixOrg},
	protocol.ModelCollaboration: {protocol.GroupPrefixRepo},
	protocol.ModelAccess:        {protocol.GroupPrefixUser},
	protocol.ModelRepoUnit:      {protocol.GroupPrefixRepo},
	// Organization labels are in owner:{id}; in org:{id} before placement
	// version 1 (clients holding them there get the marker of the move).
	protocol.ModelLabel:     {protocol.GroupPrefixRepo, protocol.GroupPrefixOwner, protocol.GroupPrefixOrg},
	protocol.ModelMilestone: {protocol.GroupPrefixRepo},
	// A repository's projects, or its owner's: org:{id} / profile:{id}
	// (owner:{id} in placement version 2; clients holding them there get
	// the marker of the move back). Their ProjectRefs: owner:{id}. Columns:
	// repo:{id}, or the owner's org:{id} / profile:{id}.
	protocol.ModelProject: {
		protocol.GroupPrefixRepo, protocol.GroupPrefixOwner, protocol.GroupPrefixOrg, protocol.GroupPrefixProfile,
	},
	protocol.ModelProjectRef:    {protocol.GroupPrefixOwner},
	protocol.ModelProjectColumn: {protocol.GroupPrefixRepo, protocol.GroupPrefixOrg, protocol.GroupPrefixProfile},
	protocol.ModelProjectIssue:  {protocol.GroupPrefixRepo},
	protocol.ModelIssue:         {protocol.GroupPrefixRepo},
	protocol.ModelIssueBody:     {protocol.GroupPrefixIssue},
	protocol.ModelIssueLabel:    {protocol.GroupPrefixRepo},
	protocol.ModelIssueAssignee: {protocol.GroupPrefixRepo},
	protocol.ModelPullRequest:   {protocol.GroupPrefixRepo},
	protocol.ModelAutoMerge:     {protocol.GroupPrefixRepo},
	protocol.ModelBranch:        {protocol.GroupPrefixRepo},
	protocol.ModelRelease:       {protocol.GroupPrefixRepo},
	protocol.ModelCommitStatus:  {protocol.GroupPrefixRepo},
	protocol.ModelActionRun:     {protocol.GroupPrefixRepo},
	protocol.ModelActionRunJob:  {protocol.GroupPrefixRepo},
	protocol.ModelNotification:  {protocol.GroupPrefixUser},
	protocol.ModelStopwatch:     {protocol.GroupPrefixUser},
	protocol.ModelIssueWatch:    {protocol.GroupPrefixUser},
	protocol.ModelWatch:         {protocol.GroupPrefixUser},
	protocol.ModelStar:          {protocol.GroupPrefixUser},
	protocol.ModelBlockedUser:   {protocol.GroupPrefixUser},
	protocol.ModelReviewState:   {protocol.GroupPrefixUser},
	// In no group (issue loads send them per viewer, B6 review); a marker
	// concerns the issue groups whose loads carried them.
	protocol.ModelIssueDependency: {protocol.GroupPrefixIssue},
	// The tracker's user:{id}; issue:{id} before placement version 1
	// (clients holding them there get the marker of the move).
	protocol.ModelTrackedTime: {protocol.GroupPrefixUser, protocol.GroupPrefixIssue},
	// A pending review, its code comments and their attachments,
	// reactions and revisions are in the reviewer's user:{id}.
	protocol.ModelComment:        {protocol.GroupPrefixIssue, protocol.GroupPrefixUser},
	protocol.ModelReview:         {protocol.GroupPrefixIssue, protocol.GroupPrefixUser},
	protocol.ModelReaction:       {protocol.GroupPrefixIssue, protocol.GroupPrefixUser},
	protocol.ModelContentHistory: {protocol.GroupPrefixIssue, protocol.GroupPrefixUser},
	// A release's attachments are in its repo:{id}.
	protocol.ModelAttachment: {protocol.GroupPrefixIssue, protocol.GroupPrefixUser, protocol.GroupPrefixRepo},
}

// canHold reports whether a group of the kind can hold entities of model.
func canHold(kind string, model protocol.Model) bool {
	kinds, ok := modelKinds[model]
	return !ok || slices.Contains(kinds, kind)
}
