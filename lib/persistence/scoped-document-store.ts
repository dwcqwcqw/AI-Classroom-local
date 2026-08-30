import type { DocumentStore, DocumentSummary, MaicDocument, SceneLike } from '@openmaic/storage';
import type { Stage } from '@openmaic/dsl';

const PREFIX_VERSION = 'u1';

function namespacePrefix(userId: string): string {
  return `${PREFIX_VERSION}:${userId}:`;
}

export function scopeDocumentStore<TScene extends SceneLike, TStage extends Stage>(
  store: DocumentStore<TScene, TStage>,
  userId: string,
): DocumentStore<TScene, TStage> {
  const prefix = namespacePrefix(userId);
  const internalStageId = (stageId: string) => `${prefix}${stageId}`;
  const externalStageId = (stageId: string) => stageId.slice(prefix.length);

  const toInternalDocument = (
    document: MaicDocument<TScene, TStage>,
  ): MaicDocument<TScene, TStage> => {
    const stageId = internalStageId(document.stage.id);
    return {
      ...document,
      stage: { ...document.stage, id: stageId },
      scenes: document.scenes.map((scene) => ({ ...scene, stageId }) as TScene),
    };
  };

  const toExternalDocument = (
    document: MaicDocument<TScene, TStage>,
  ): MaicDocument<TScene, TStage> => {
    const stageId = externalStageId(document.stage.id);
    return {
      ...document,
      stage: { ...document.stage, id: stageId },
      scenes: document.scenes.map((scene) => ({ ...scene, stageId }) as TScene),
    };
  };

  return {
    async saveDocument(document) {
      await store.saveDocument(toInternalDocument(document));
    },
    async loadDocument(stageId) {
      const document = await store.loadDocument(internalStageId(stageId));
      return document ? toExternalDocument(document) : null;
    },
    async listDocuments(): Promise<DocumentSummary[]> {
      return (await store.listDocuments())
        .filter((summary) => summary.id.startsWith(prefix))
        .map((summary) => ({ ...summary, id: externalStageId(summary.id) }));
    },
    async deleteDocument(stageId) {
      await store.deleteDocument(internalStageId(stageId));
    },
    async putStage(stageId, stage) {
      const internalId = internalStageId(stageId);
      await store.putStage(internalId, { ...stage, id: internalId });
    },
    async putScene(stageId, scene) {
      const internalId = internalStageId(stageId);
      await store.putScene(internalId, { ...scene, stageId: internalId } as TScene);
    },
    async getScene(stageId, sceneId) {
      const scene = await store.getScene(internalStageId(stageId), sceneId);
      return scene ? ({ ...scene, stageId } as TScene) : null;
    },
    async deleteScene(stageId, sceneId) {
      await store.deleteScene(internalStageId(stageId), sceneId);
    },
  };
}
