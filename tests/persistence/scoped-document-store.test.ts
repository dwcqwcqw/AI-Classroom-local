import type { DocumentStore, MaicDocument } from '@openmaic/storage';
import { describe, expect, it } from 'vitest';

import { scopeDocumentStore } from '@/lib/persistence/scoped-document-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

function document(stageId: string, name: string): MaicDocument<AppScene, AppStage> {
  return {
    stage: {
      id: stageId,
      name,
      description: '',
      createdAt: 1,
      updatedAt: 2,
      agentIds: [],
      interactiveMode: false,
      taskEngineMode: false,
    } as AppStage,
    scenes: [
      {
        id: 'scene-1',
        stageId,
        title: '第一课',
        order: 0,
        type: 'slide',
        content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } },
      } as unknown as AppScene,
    ],
  };
}

function memoryStore(): {
  store: DocumentStore<AppScene, AppStage>;
  rows: Map<string, MaicDocument<AppScene, AppStage>>;
} {
  const rows = new Map<string, MaicDocument<AppScene, AppStage>>();
  const store: DocumentStore<AppScene, AppStage> = {
    async saveDocument(value) {
      rows.set(value.stage.id, structuredClone(value));
    },
    async loadDocument(stageId) {
      return structuredClone(rows.get(stageId) ?? null);
    },
    async listDocuments() {
      return [...rows.values()].map(({ stage, scenes }) => ({
        id: stage.id,
        name: stage.name,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
        sceneCount: scenes.length,
      }));
    },
    async deleteDocument(stageId) {
      rows.delete(stageId);
    },
    async putStage(stageId, stage) {
      const current = rows.get(stageId);
      if (current) rows.set(stageId, { ...current, stage: structuredClone(stage) });
    },
    async putScene(stageId, scene) {
      const current = rows.get(stageId);
      if (!current) return;
      rows.set(stageId, {
        ...current,
        scenes: [...current.scenes.filter((item) => item.id !== scene.id), structuredClone(scene)],
      });
    },
    async getScene(stageId, sceneId) {
      return structuredClone(
        rows.get(stageId)?.scenes.find((scene) => scene.id === sceneId) ?? null,
      );
    },
    async deleteScene(stageId, sceneId) {
      const current = rows.get(stageId);
      if (current) {
        rows.set(stageId, {
          ...current,
          scenes: current.scenes.filter((scene) => scene.id !== sceneId),
        });
      }
    },
  };
  return { store, rows };
}

describe('scoped document store', () => {
  it('isolates identical external course ids between authenticated users', async () => {
    const { store, rows } = memoryStore();
    const alice = scopeDocumentStore(store, 'user-alice');
    const bob = scopeDocumentStore(store, 'user-bob');

    await alice.saveDocument(document('course-1', 'Alice 课程'));
    await bob.saveDocument(document('course-1', 'Bob 课程'));

    expect([...rows.keys()]).toEqual(['u1:user-alice:course-1', 'u1:user-bob:course-1']);
    await expect(alice.listDocuments()).resolves.toMatchObject([
      { id: 'course-1', name: 'Alice 课程' },
    ]);
    await expect(bob.listDocuments()).resolves.toMatchObject([
      { id: 'course-1', name: 'Bob 课程' },
    ]);
    expect((await alice.loadDocument('course-1'))?.scenes[0]?.stageId).toBe('course-1');
    expect((await bob.loadDocument('course-1'))?.stage.name).toBe('Bob 课程');
  });

  it('keeps incremental scene reads and writes inside the user namespace', async () => {
    const { store, rows } = memoryStore();
    const alice = scopeDocumentStore(store, 'user-alice');
    await alice.saveDocument(document('course-1', 'Alice 课程'));

    const nextScene = {
      ...(await alice.getScene('course-1', 'scene-1'))!,
      title: '更新后的第一课',
    };
    await alice.putScene('course-1', nextScene);

    expect(rows.get('u1:user-alice:course-1')?.scenes[0]?.stageId).toBe('u1:user-alice:course-1');
    await expect(alice.getScene('course-1', 'scene-1')).resolves.toMatchObject({
      stageId: 'course-1',
      title: '更新后的第一课',
    });
  });
});
