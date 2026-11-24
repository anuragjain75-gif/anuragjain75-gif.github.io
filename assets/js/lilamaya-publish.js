const pending = new Set(['validating', 'submitting', 'submitted', 'deploying']);
const labels = {
  validating: 'Publishing…',
  submitting: 'Submitting…',
  submitted: 'Publication accepted',
  deploying: 'Deploying…',
  live: 'Live verified',
  'writes-disabled': 'Live publishing disabled',
  'no-changes': 'No publication changes',
  failed: 'Publication failed',
  rejected: 'Publication rejected',
  unknown: 'Publication outcome uncertain',
  unverified: 'Deployment unverified',
  superseded: 'Deployment superseded',
  timed_out: 'Deployment timed out',
  cancelled: 'Deployment cancelled',
};

export function installPublisher({button, status, getState}) {
  let active;
  let requesting = false;
  let timer;

  function render() {
    const state = getState();
    button.disabled = !state.eligible || requesting || pending.has(active?.status) || active?.status === 'unknown';
    button.title = state.reason;
    if (!active) return;
    const earlier = active.path !== state.path || active.revision !== state.sha;
    status.hidden = false;
    status.textContent = (earlier ? 'Earlier saved version · ' : '') +
      (labels[active.status] || active.status) + (active.message ? ' · ' + active.message : '');
    if (active.status === 'live' && active.liveURL) {
      const link = document.createElement('a');
      link.textContent = ' · Open live';
      link.href = active.liveURL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      status.append(link);
    }
  }

  async function request(route, options) {
    const response = await fetch('/publishing/' + route, {cache: 'no-store', ...options});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Publication request failed.'), {http: true});
    return result;
  }

  function poll() {
    if (!pending.has(active.status) && active.status !== 'unknown') return;
    timer = setTimeout(async () => {
      try {
        active = await request('status?ticket=' + active.ticket);
      } catch {
        active.message = 'Status is unavailable. The submission has not been retried.';
      }
      render();
      poll();
    }, 1000);
  }

  button.addEventListener('click', async () => {
    const state = getState();
    if (button.disabled || !state.eligible || requesting) return;
    clearTimeout(timer);
    requesting = true;
    const ticket = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte =>
      byte.toString(16).padStart(2, '0')).join('');
    active = {ticket, path: state.path, revision: state.sha, status: 'validating', message: 'Checking the saved article and publication target.'};
    render();
    let posting = false;
    try {
      const {csrf} = await request('desk-session', {headers: {'X-Writing-Desk': 'publish'}});
      const current = getState();
      if (!current.eligible || current.path !== state.path || current.sha !== state.sha) {
        throw new Error('The editor changed before publishing. Save and publish the selected version.');
      }
      posting = true;
      active = await request('publish', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({csrf, ticket, path: state.path, sha: state.sha}),
      });
    } catch (error) {
      const uncertain = posting && !error.http;
      active.status = uncertain ? 'unknown' : 'failed';
      active.message = uncertain ? 'The server response was lost. Checking publication status.' : error.message;
    } finally {
      requesting = false;
      render();
      poll();
    }
  });

  return {render};
}
