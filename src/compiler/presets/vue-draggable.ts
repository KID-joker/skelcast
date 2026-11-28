import type {ComponentPreset} from './types.js';
import {UNKNOWN,sourceObject} from '../expression.js';
/** Initial list layout only. Sortable callbacks and drag effects never run. */
export const vueDraggablePreset:ComponentPreset={
 id:'vuedraggable',package:'vuedraggable',
 resolve:reference=>reference.request==='vuedraggable'&&['default','draggable'].includes(reference.exported)?'draggable':undefined,
 role:name=>name==='draggable'?'layout':undefined,
 slots:()=>['header','footer'],
 frames:(_name,props)=>{const list=props.modelValue??props.list;return Array.isArray(list)?list.slice(0,256).map((element,index)=>({key:String(index),slot:'item',argument:sourceObject({element,index})})):[]},
 present:(_name,props,_text,_hints,policy)=>({tag:typeof props.tag==='string'&&/^(div|ul|ol|section|main)$/.test(props.tag)?props.tag:'div',children:policy.slots.header+(policy.frames??[]).map(frame=>frame.html).join('')+policy.slots.footer,notes:!Array.isArray(props.modelValue??props.list)||props.modelValue===UNKNOWN?['Draggable list is unknown; declare a finite list state. Runtime sorting is not reconstructed.']:[]}),
};
