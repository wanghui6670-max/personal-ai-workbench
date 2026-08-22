export const engineeringMethodsPack={
  id:'engineering-methods',
  name:'Engineering Methods',
  version:'1.0.0',
  capabilities:[{
    id:'engineering.discipline',
    kind:'method_pack',
    description:'Reusable product and engineering disciplines for Harness agents.'
  }],
  methods:[
    {
      id:'method.first-principles',
      name:'First Principles',
      description:'Reduce the problem to irreducible facts, constraints and desired outcomes before choosing an implementation.',
      contentRef:'docs/HARNESS_FIRST_PRD_V1.md',
      metadata:{stage:'problem-framing'}
    },
    {
      id:'method.superpowers-cycle',
      name:'Superpowers Engineering Cycle',
      description:'Design before code, define acceptance evidence, implement the smallest complete slice, review, and verify before claiming completion.',
      contentRef:'docs/HARNESS_FIRST_PRD_V1.md',
      metadata:{sequence:['first-principles','design','acceptance-tests','small-slice','run-tests','review','verify']}
    }
  ],
  skills:[
    {id:'skill.problem-framing',name:'Problem Framing',description:'Separate facts, assumptions, constraints and desired outcomes.'},
    {id:'skill.design-before-code',name:'Design Before Code',description:'Write the smallest coherent design and contracts before implementation.'},
    {id:'skill.test-first',name:'Test First',description:'Express acceptance behavior as executable tests before or alongside the implementation slice.'},
    {id:'skill.systematic-debugging',name:'Systematic Debugging',description:'Reproduce, isolate, identify root cause, fix the cause, then add regression coverage.'},
    {id:'skill.review',name:'Review',description:'Inspect implementation against contracts, safety boundaries and scope.'},
    {id:'skill.verify-before-complete',name:'Verify Before Complete',description:'Require concrete test/readback evidence before claiming completion.'}
  ],
  tools:[],
  agents:[],
  schedules:[],
  views:[],
  metadata:{coreIndependent:true,toolPermissions:'none'}
};
