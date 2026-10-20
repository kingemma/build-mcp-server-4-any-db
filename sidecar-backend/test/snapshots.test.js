'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  SnapshotStore,
  SnapshotStoreError,
  MAX_PER_PROJECT,
  buildRollbackPatch,
  roleNamesOf,
  rolesForWrite,
  accessForWrite,
} = require('../src/snapshots');

function withStore(run) {
  const store = new SnapshotStore(':memory:');
  try {
    return run(store);
  } finally {
    store.close();
  }
}

const ADMIN = { name: 'admin', tables: [] };
const READONLY = {
  name: 'readonly',
  tables: [{ name: 'accounts', database: 'app', query: { block: false } }],
};

test('save / list / get：返回摘要，get 才带 roles 全文', () => {
  withStore((store) => {
    const saved = store.save({
      projectDir: 'projects/app',
      baseUrl: 'http://127.0.0.1:1',
      database: 'app',
      roles: [ADMIN, READONLY],
    });
    assert.ok(saved.id > 0);
    assert.strictEqual(saved.roleCount, 2);
    assert.strictEqual(saved.database, 'app');
    assert.strictEqual(saved.reason, 'before-apply');
    assert.strictEqual(saved.roles, undefined);

    const list = store.list({ projectDir: 'projects/app' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, saved.id);

    const full = store.get(saved.id);
    assert.deepStrictEqual(full.roles, [ADMIN, READONLY]);
  });
});

test('项目身份：projectDir 优先，baseUrl 仅在没有目录时使用', () => {
  withStore((store) => {
    store.save({ projectDir: '.', roles: [] });
    store.save({ baseUrl: 'http://a', roles: [] });

    assert.strictEqual(store.list({ projectDir: '.' }).length, 1);
    assert.strictEqual(store.list({ baseUrl: 'http://a' }).length, 1);
    // projectDir 存在时 baseUrl 不参与身份，换端口也能查到
    assert.strictEqual(store.list({ projectDir: '.' }).length, 1);
  });
});

test('list：limit 生效且按时间倒序', () => {
  withStore((store) => {
    for (let i = 0; i < 5; i += 1) {
      store.save({ projectDir: 'p', roles: [] });
    }
    const list = store.list({ projectDir: 'p', limit: 2 });
    assert.strictEqual(list.length, 2);
    assert.ok(list[0].id > list[1].id);
  });
});

test('prune：单项目只保留最近 MAX_PER_PROJECT 份', () => {
  withStore((store) => {
    for (let i = 0; i < MAX_PER_PROJECT + 5; i += 1) {
      store.save({ projectDir: 'p', roles: [] });
    }
    assert.strictEqual(store.list({ projectDir: 'p', limit: 100 }).length, MAX_PER_PROJECT);
  });
});

test('remove：删除单份快照', () => {
  withStore((store) => {
    const saved = store.save({ projectDir: 'p', roles: [] });
    assert.strictEqual(store.remove(saved.id), true);
    assert.strictEqual(store.remove(saved.id), false);
    assert.strictEqual(store.get(saved.id), null);
  });
});

test('save：缺少项目身份或 roles 非法时报错', () => {
  withStore((store) => {
    assert.throws(() => store.save({ roles: [] }), SnapshotStoreError);
    assert.throws(() => store.save({ projectDir: 'p', roles: 'x' }), /roles 必须是数组/);
    assert.throws(() => store.get('1'), /id 必须是整数/);
  });
});

test('roleNamesOf：过滤空名字', () => {
  assert.deepStrictEqual(roleNamesOf([{ name: 'a' }, { name: '' }, null, { name: 'b' }]), ['a', 'b']);
  assert.deepStrictEqual(roleNamesOf(null), []);
});

test('buildRollbackPatch：恢复快照角色，删除本次新增的角色', () => {
  const patch = buildRollbackPatch([ADMIN], [ADMIN, READONLY, { name: 'no_access' }]);
  assert.deepStrictEqual(patch.roles, [ADMIN]);
  assert.deepStrictEqual(patch.remove_roles, ['readonly', 'no_access']);
});

test('buildRollbackPatch：永不删除 admin，也不删除额外保护角色', () => {
  const patch = buildRollbackPatch([], [{ name: 'admin' }, { name: 'platform' }, { name: 'x' }], {
    protectedRoles: ['platform'],
  });
  assert.deepStrictEqual(patch.remove_roles, ['x']);
});

test('buildRollbackPatch：没有新增角色时不带 remove_roles', () => {
  const patch = buildRollbackPatch([ADMIN], [ADMIN]);
  assert.deepStrictEqual(patch, { roles: [ADMIN] });
});

test('buildRollbackPatch：快照缺少 roles 时按空数组处理', () => {
  const patch = buildRollbackPatch(undefined, [ADMIN, READONLY]);
  assert.deepStrictEqual(patch.roles, []);
  assert.deepStrictEqual(patch.remove_roles, ['readonly']);
});

test('rolesForWrite：把 Go 结构体直出的 Name/Query 转成回写 schema 要的 name/query', () => {
  const raw = [
    {
      name: 'readonly',
      tables: [
        {
          Name: 'accounts',
          database: 'app',
          Schema: '',
          read_only: false,
          Query: {
            Block: false,
            Columns: ['id', 'name'],
            Filters: ['{ id: { _gt: 1 } }'],
            Limit: 5,
          },
          Insert: { Block: true },
          Update: { Block: true },
          Delete: { Block: true },
        },
      ],
    },
  ];

  assert.deepStrictEqual(rolesForWrite(raw), [
    {
      name: 'readonly',
      tables: [
        {
          name: 'accounts',
          database: 'app',
          query: {
            block: false,
            filters: ['{ id: { _gt: 1 } }'],
            columns: ['id', 'name'],
            limit: 5,
          },
          insert: { block: true },
          update: { block: true },
          delete: { block: true },
        },
      ],
    },
  ]);
});

test('rolesForWrite：缺 database 时用快照的库名兜底，跳过没有表名的脏条目', () => {
  const normalized = rolesForWrite(
    [
      {
        name: 'analyst',
        tables: [
          { Name: 'orders', Query: { Block: false } },
          { Query: { Block: false } },
        ],
      },
    ],
    { database: 'app' }
  );

  assert.strictEqual(normalized[0].tables.length, 1);
  assert.strictEqual(normalized[0].tables[0].database, 'app');
});

test('buildRollbackPatch：回放前归一化表名，不会把原始 Go 字段直接发给 GraphJin', () => {
  const patch = buildRollbackPatch(
    [{ name: 'admin', tables: [{ Name: 'accounts', database: 'app', Query: { Block: false } }] }],
    [{ name: 'admin' }]
  );

  assert.strictEqual(patch.roles[0].tables[0].name, 'accounts');
  assert.strictEqual(patch.roles[0].tables[0].query.block, false);
});

test('save：source 模式同时保存每个源的 access，get 能读回', () => {
  withStore((store) => {
    const access = {
      read: 'authenticated',
      write: 'blocked',
      delete: 'blocked',
      grants: [{ role: 'analyst', tables: [{ name: 'orders', columns: ['id'] }] }],
    };
    const saved = store.save({
      projectDir: 'projects/app',
      roles: [ADMIN],
      sources: [{ name: 'app', access }],
    });

    assert.strictEqual(saved.sourceCount, 1);
    assert.deepStrictEqual(store.get(saved.id).sources, [{ name: 'app', access }]);
  });
});

test('buildRollbackPatch：带 sources 时生成 source_patches，只回写 access', () => {
  const patch = buildRollbackPatch([ADMIN], [ADMIN], {
    sources: [
      {
        name: 'app',
        access: {
          read: 'authenticated',
          write: 'owner',
          delete: 'blocked',
          owner_column: 'owner_code',
          grants: [{ role: 'analyst', tables: [{ name: 'orders', columns: ['id'], filter: '{ a: 1 }' }] }],
        },
      },
    ],
  });

  assert.deepStrictEqual(patch.source_patches, [
    {
      name: 'app',
      access: {
        read: 'authenticated',
        write: 'owner',
        delete: 'blocked',
        owner_column: 'owner_code',
        grants: [{ role: 'analyst', tables: [{ name: 'orders', columns: ['id'], filter: '{ a: 1 }' }] }],
      },
    },
  ]);
});

test('accessForWrite：兼容 Go 结构体的 PascalCase 字段', () => {
  const access = accessForWrite({
    Read: 'owner',
    Write: 'owner',
    Delete: 'blocked',
    OwnerColumn: 'owner_code',
    BlockedTables: ['secrets'],
    Grants: [{ Role: 'analyst', Tables: [{ Name: 'orders', Columns: ['id'], Filter: '{ a: 1 }' }] }],
  });

  assert.deepStrictEqual(access, {
    read: 'owner',
    write: 'owner',
    delete: 'blocked',
    owner_column: 'owner_code',
    blocked_tables: ['secrets'],
    grants: [{ role: 'analyst', tables: [{ name: 'orders', columns: ['id'], filter: '{ a: 1 }' }] }],
  });
});

test('旧库升级：自动补上 source_access_json / source_count 列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-upgrade-'));
  const dbPath = path.join(dir, 'snapshots.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE policy_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key TEXT NOT NULL,
    project_dir TEXT,
    base_url TEXT,
    database TEXT,
    reason TEXT NOT NULL,
    roles_json TEXT NOT NULL,
    role_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );`);
  raw.close();

  const store = new SnapshotStore(dbPath);
  try {
    const saved = store.save({ projectDir: dir, roles: [ADMIN], sources: [{ name: 'app', access: { read: 'authenticated' } }] });
    assert.strictEqual(saved.sourceCount, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
