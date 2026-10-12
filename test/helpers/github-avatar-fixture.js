import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha1').update(bytes).digest('hex');
export const gitBlobSha = bytes => hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));

/** HTTP contract fixture: immutable Git objects and compare-and-swap branch refs. */
export class GithubAvatarFixture {
  constructor({ owner = 'fixture', repo = 'avatars', branch = 'main', token = 'isolated-fixture', files = {} } = {}) {
    Object.assign(this, { owner, repo, branch, token });
    this.calls = []; this.trees = new Map(); this.commits = new Map(); this.blobs = new Map(); this.serial = 0;
    this.seed(files);
  }
  get files() { return this.commits.get(this.head).files; }
  seed(files) {
    const next = new Map(this.head ? this.files : []);
    for (const [path, bytes] of Object.entries(files)) next.set(path, Buffer.from(bytes));
    this.head = this.commit(next, this.head ? [this.head] : []);
  }
  commit(files, parents) {
    const tree = this.tree(files), sha = hash(`commit ${++this.serial} ${tree} ${parents.join(' ')}`);
    this.commits.set(sha, { files, tree, parents }); return sha;
  }
  tree(files) {
    const sha = hash(JSON.stringify([...files].map(([path, bytes]) => [path, gitBlobSha(bytes)]).sort()));
    this.trees.set(sha, new Map(files));
    for (const bytes of files.values()) this.blobs.set(gitBlobSha(bytes), bytes);
    return sha;
  }
  resolve(ref) { return !ref || ref === this.branch ? this.files : this.commits.get(ref)?.files; }
  async fetch(url, init = {}) { return this.handle(new Request(url, init)); }
  async handle(request) {
    const url = new URL(request.url), base = `/repos/${this.owner}/${this.repo}`, method = request.method;
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(request.headers.get('authorization'), `Bearer ${this.token}`);
    assert.ok(url.pathname.startsWith(base));
    const route = decodeURIComponent(url.pathname.slice(base.length));
    const call = { method, route, accept: request.headers.get('accept'), ref: url.searchParams.get('ref') }; this.calls.push(call);
    const intercepted = await this.beforeRequest?.({ request, url, route, call, fixture: this });
    if (intercepted) return intercepted;
    if (!route && method === 'GET') return Response.json({ private: this.private !== false });
    if (route.startsWith('/contents/')) {
      const path = route.slice('/contents/'.length), files = this.resolve(call.ref);
      if (!files) return Response.json({}, { status: 404 });
      if (method === 'GET') {
        const bytes = files.get(path);
        if (bytes) {
          if (call.accept === 'application/vnd.github.raw+json') return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } });
          return Response.json({ type: 'file', name: path.split('/').at(-1), path, sha: gitBlobSha(bytes), size: bytes.length,
            encoding: bytes.length > 1024 * 1024 ? 'none' : 'base64', content: bytes.length > 1024 * 1024 ? '' : bytes.toString('base64') });
        }
        const entries = new Map();
        for (const [name, value] of files) {
          if (!name.startsWith(`${path}/`)) continue;
          const relative = name.slice(path.length + 1), first = relative.split('/')[0], childPath = `${path}/${first}`;
          entries.set(first, relative.includes('/') ? { name: first, path: childPath, type: 'dir', sha: hash(childPath) }
            : { name: first, path: childPath, type: 'file', sha: gitBlobSha(value), size: value.length });
        }
        if (!entries.size) return Response.json({}, { status: 404 });
        return Response.json([...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000));
      }
      const input = await request.json(), prior = this.files.get(path);
      if (method === 'PUT') {
        if ((prior && input.sha !== gitBlobSha(prior)) || (!prior && input.sha)) return Response.json({ message: 'sha does not match' }, { status: 409 });
        assert.equal(input.branch, this.branch);
        const bytes = Buffer.from(input.content, 'base64');
        this.seed({ [path]: bytes });
        return Response.json({ content: { sha: gitBlobSha(bytes) }, commit: { sha: this.head } }, { status: prior ? 200 : 201 });
      }
      if (method === 'DELETE') {
        if (!prior) return Response.json({}, { status: 404 });
        if (input.sha !== gitBlobSha(prior)) return Response.json({}, { status: 409 });
        const next = new Map(this.files); next.delete(path); this.head = this.commit(next, [this.head]);
        return Response.json({ content: null, commit: { sha: this.head } });
      }
    }
    if (route === `/git/ref/heads/${this.branch}` && method === 'GET') return Response.json({ object: { type: 'commit', sha: this.head } });
    if (route.startsWith('/git/commits/') && method === 'GET') {
      const commit = this.commits.get(route.split('/').at(-1));
      return commit ? Response.json({ tree: { sha: commit.tree }, parents: commit.parents.map(sha => ({ sha })) }) : Response.json({}, { status: 404 });
    }
    if (route === '/git/trees' && method === 'POST') {
      const input = await request.json(), files = new Map(this.trees.get(input.base_tree));
      assert.ok(this.trees.has(input.base_tree));
      for (const entry of input.tree) {
        assert.equal(entry.mode, '100644'); assert.equal(entry.type, 'blob');
        if (entry.sha === null) files.delete(entry.path);
        else if (typeof entry.content === 'string') files.set(entry.path, Buffer.from(entry.content));
        else { assert.ok(this.blobs.has(entry.sha)); files.set(entry.path, this.blobs.get(entry.sha)); }
      }
      return Response.json({ sha: this.tree(files) }, { status: 201 });
    }
    if (route === '/git/commits' && method === 'POST') {
      const input = await request.json(), files = this.trees.get(input.tree);
      assert.ok(files); return Response.json({ sha: this.commit(new Map(files), input.parents) }, { status: 201 });
    }
    if (route === `/git/refs/heads/${this.branch}` && method === 'PATCH') {
      const input = await request.json(), next = this.commits.get(input.sha);
      assert.equal(input.force, false);
      if (!next?.parents.includes(this.head)) return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
      this.head = input.sha; return Response.json({ object: { sha: this.head } });
    }
    throw new Error(`Unexpected GitHub fixture route ${method} ${route}`);
  }
}
