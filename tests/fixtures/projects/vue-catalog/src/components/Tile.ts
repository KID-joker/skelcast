import {defineComponent,h,useAttrs,useSlots} from 'vue';
const preserve=<T>(component:T):T=>{const result=component;return result;};
const Tile=defineComponent({inheritAttrs:false,props:{height:{type:Number,default:96}},setup(props){
 const attrs=useAttrs(),slots=useSlots();
 const style={height:props.height+'px'};
 return()=>h('article',{...attrs,style},[slots.default?.(),slots.footer?.()]);
}});
export default preserve(Tile);
