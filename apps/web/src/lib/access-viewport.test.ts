import { describe,expect,it,vi } from 'vitest';
import { revealAccessTarget } from './access-viewport';
const normal={mode:'normal' as const,keyboard:false,prefersReducedMotion:false,hidden:false};
describe('access flow viewport return',()=>{
  it('focuses the result immediately then reveals it with smooth native scrolling for normal pointer use',()=>{
    const events:unknown[]=[];const target={focus:(options?:FocusOptions)=>events.push(['focus',options]),scrollIntoView:(options?:boolean|ScrollIntoViewOptions)=>events.push(['scroll',options])};
    revealAccessTarget(target,normal);
    expect(events).toEqual([['focus',{preventScroll:true}],['scroll',{behavior:'smooth',block:'start',inline:'nearest'}]]);
  });
  it('uses explicit instant scrolling for reduced/off, keyboard, OS reduced-motion and hidden pages',()=>{
    for(const motion of [{...normal,mode:'reduced' as const},{...normal,mode:'off' as const},{...normal,keyboard:true},{...normal,prefersReducedMotion:true},{...normal,hidden:true}]) {
      const target={focus:vi.fn(),scrollIntoView:vi.fn()};revealAccessTarget(target,motion);
      expect(target.focus).toHaveBeenCalledWith({preventScroll:true});
      expect(target.scrollIntoView).toHaveBeenCalledWith({behavior:'instant',block:'start',inline:'nearest'});
    }
  });
  it('does nothing for an unmounted or denied target',()=>{expect(()=>revealAccessTarget(null,normal)).not.toThrow();});
});
