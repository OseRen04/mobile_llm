import { InferenceClient } from './inference-client';
import { MODEL_MANIFEST, MODEL_CACHE, modelAssetUrl, installModel, getModelStatuses, deleteModel } from '../../../packages/model-manager/src';
import './register-sw';

if (import.meta.env.VITE_MODEL_TEST === '1') {
  Object.assign(window, { __translatorTest: {
    manifest: MODEL_MANIFEST, assetUrl: modelAssetUrl, cacheName: MODEL_CACHE,
    installModel, getModelStatuses, deleteModel,
    client: new InferenceClient(() => undefined),
  } });
}
