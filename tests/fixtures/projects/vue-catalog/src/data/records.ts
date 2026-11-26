const heights=[96,120,144];
export default heights.slice().reverse().map((height,index)=>({id:index+1,title:`Catalog item ${index+1}`,height}));
