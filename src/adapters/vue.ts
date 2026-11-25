import { defineComponent, h, onMounted, onUpdated, onBeforeUnmount, ref, watch, type PropType } from 'vue';
import type { SkeletonArtifact } from '../types.js';
import { createSkeletonMount, currentArtifact, forced, registerBoundary, subscribeBoundary } from '../runtime/core.js';

export const LoadingBoundary = defineComponent({
  name: 'SkeletonLoadingBoundary',
  props: {
    artifact: { type: Object as PropType<SkeletonArtifact>, required: true },
    pending: { type: Boolean, required: true },
    variant: String,
  },
  setup(props, { slots }) {
    const root = ref<HTMLElement>();
    const skeleton = ref<HTMLElement>();
    const revision = ref(0);
    const mount = createSkeletonMount();
    let unsubscribe: (() => void) | undefined;
    let registration: ReturnType<typeof registerBoundary> | undefined;
    const updateSkeleton = () => {
      const artifact = currentArtifact(props.artifact);
      const show = props.pending || forced(artifact.id, artifact.kind);
      skeleton.value?.style.setProperty('display', show ? 'block' : 'none', 'important');
      skeleton.value?.nextElementSibling?.setAttribute('style', `display:${show ? 'none' : 'block'}!important`);
      if (skeleton.value) mount.update(skeleton.value, show, artifact, props.variant);
    };
    const connect = () => {
      unsubscribe?.();
      unsubscribe = subscribeBoundary(props.artifact.id, props.artifact.kind, () => { revision.value++; updateSkeleton(); });
    };
    onMounted(() => {
      connect();
      registration = registerBoundary({ id: props.artifact.id, kind: props.artifact.kind, pending: props.pending, variant: props.variant, artifact: props.artifact, element: root.value });
      updateSkeleton();
    });
    onUpdated(updateSkeleton);
    watch(() => [props.artifact.id, props.artifact.kind], () => { if (registration) connect(); });
    watch(() => [props.pending, props.artifact, props.variant], () => { registration?.update({ id: props.artifact.id, kind: props.artifact.kind, pending: props.pending, variant: props.variant, artifact: props.artifact }); updateSkeleton(); });
    onBeforeUnmount(() => { unsubscribe?.(); registration?.dispose(); mount.dispose(); });
    return () => {
      void revision.value;
      const artifact = currentArtifact(props.artifact);
      const show = props.pending || forced(artifact.id, artifact.kind);
      return h('div', { ref: root, style: { minWidth: 0 }, 'data-sk-boundary': artifact.id, 'data-sk-visible': String(show), 'aria-busy': props.pending }, [
        h('div', { ref: skeleton, hidden: !show, style: { display: show ? 'block' : 'none' }, 'aria-hidden': 'true' }),
        h('div', { hidden: show, style: { display: show ? 'none' : 'block' }, inert: show || undefined, 'data-sk-content': '' }, slots.default?.()),
      ]);
    };
  },
});
