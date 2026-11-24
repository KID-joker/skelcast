import { defineComponent, h, onMounted, onBeforeUnmount, ref, watch, type PropType } from 'vue';
import type { SkeletonArtifact } from '../types.js';
import { currentArtifact, forced, getPreview, mountSkeleton, registerBoundary, subscribe } from '../runtime/core.js';

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
    let cleanup: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let registration: ReturnType<typeof registerBoundary> | undefined;
    let lastArtifact: SkeletonArtifact | undefined, lastVariant: string | undefined, lastHighlight: boolean | undefined;
    const updateSkeleton = () => {
      const artifact = currentArtifact(props.artifact);
      const variant = getPreview().variant ?? props.variant;
      const highlight = getPreview().highlight;
      if (skeleton.value && (artifact !== lastArtifact || variant !== lastVariant || highlight !== lastHighlight)) {
        cleanup?.(); cleanup = mountSkeleton(skeleton.value, artifact, props.variant);
        lastArtifact = artifact; lastVariant = variant; lastHighlight = highlight;
      }
    };
    onMounted(() => {
      unsubscribe = subscribe(() => { revision.value++; updateSkeleton(); });
      registration = registerBoundary({ id: props.artifact.id, kind: props.artifact.kind, pending: props.pending, artifact: props.artifact, element: root.value });
      updateSkeleton();
    });
    watch(() => [props.pending, props.artifact, props.variant], () => { registration?.update({ pending: props.pending, artifact: props.artifact }); updateSkeleton(); });
    onBeforeUnmount(() => { unsubscribe?.(); registration?.dispose(); cleanup?.(); });
    return () => {
      void revision.value;
      const artifact = currentArtifact(props.artifact);
      const show = props.pending || forced(artifact.id, artifact.kind);
      return h('div', { ref: root, 'data-sk-boundary': artifact.id, 'data-sk-visible': String(show), 'aria-busy': props.pending }, [
        h('div', { ref: skeleton, hidden: !show, 'aria-hidden': 'true' }),
        h('div', { hidden: show, inert: show || undefined, 'data-sk-content': '' }, slots.default?.()),
      ]);
    };
  },
});
