package livesync

import (
	"testing"

	"forgejo.org/modules/setting"
	"github.com/stretchr/testify/assert"
)

func TestNextConfigWIPPrefixes(t *testing.T) {
	previous := setting.Repository.PullRequest.WorkInProgressPrefixes
	t.Cleanup(func() { setting.Repository.PullRequest.WorkInProgressPrefixes = previous })
	setting.Repository.PullRequest.WorkInProgressPrefixes = []string{"Draft:", "[Work]"}
	assert.Equal(t, []string{"Draft:", "[Work]"}, *nextConfig().WIPPrefixes)
	setting.Repository.PullRequest.WorkInProgressPrefixes = nil
	assert.NotNil(t, nextConfig().WIPPrefixes)
	assert.Empty(t, *nextConfig().WIPPrefixes)
}
