import { computed, defineComponent, h, onMounted, onUpdated, onBeforeUnmount, ref, watch, type PropType } from 'vue';
import { applyPresentationDisplay, boundaryPresentation } from '../runtime/presentation.js';
import type { SkeletonArtifact } from '../types.js';
import { createSkeletonMount, currentArtifact, registerBoundary, subscribeBoundary } from '../runtime/core.js';

export const LoadingBoundary = defineComponent({
  name: 'SkeletonLoadingBoundary',
  props: {
    artifact: { type: Object as PropType<SkeletonArtifact>, required: true },
    pending: { type: Boolean, required: true },
    variant: String,
    context: String,
  },
  setup(props, { slots }) {
    const root = ref<HTMLElement>();
    const skeleton = ref<HTMLElement>();
    const revision = ref(0);
    const state = computed(() => {
      void revision.value;
      const artifact = currentArtifact(props.artifact);
      return { artifact, presentation: boundaryPresentation(artifact.id, artifact.kind, props.pending) };
    });
    const mount = createSkeletonMount();
    let unsubscribe: (() => void) | undefined;
    let registration: ReturnType<typeof registerBoundary> | undefined;
    const updateSkeleton = () => {
      const { artifact, presentation } = state.value;
      const show = presentation.skeletonVisible;
      if (root.value && skeleton.value) applyPresentationDisplay(root.value, skeleton.value, presentation);
      if (skeleton.value) mount.update(skeleton.value, show, artifact, props.variant, props.context);
    };
    const connect = () => {
      unsubscribe?.();
      unsubscribe = subscribeBoundary(props.artifact.id, props.artifact.kind, () => { revision.value++; });
    };
    onMounted(() => {
      connect();
      registration = registerBoundary({ id: props.artifact.id, kind: props.artifact.kind, pending: props.pending, variant: props.variant, context: props.context, artifact: props.artifact, element: root.value });
      updateSkeleton();
    });
    onUpdated(updateSkeleton);
    watch(() => [props.artifact.id, props.artifact.kind], () => { if (registration) connect(); });
    watch(() => [props.pending, props.artifact, props.variant, props.context], () => { registration?.update({ id: props.artifact.id, kind: props.artifact.kind, pending: props.pending, variant: props.variant, context: props.context, artifact: props.artifact }); });
    onBeforeUnmount(() => { unsubscribe?.(); registration?.dispose(); mount.dispose(); });
    return () => {
      const { artifact, presentation } = state.value;
      const show = presentation.skeletonVisible;
      return h('div', { ref: root, style: presentation.rootStyle, 'data-sk-comparison': presentation.comparison, 'data-sk-boundary': artifact.id, 'data-sk-source-context': props.context, 'data-sk-visible': String(show), 'aria-busy': props.pending }, [
        h('div', { 'aria-hidden':!presentation.contentVisible||undefined, style: presentation.contentStyle, inert: !presentation.contentVisible || undefined, 'data-sk-content': '' }, slots.default?.()),
        h('div', { ref: skeleton, hidden: !show, style: presentation.skeletonStyle, 'aria-hidden': 'true', 'data-sk-skeleton': '' }),
      ]);
    };
  },
});
