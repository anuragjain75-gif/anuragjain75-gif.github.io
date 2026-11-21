// Shared assignment interaction; collection loading/mutations remain with the caller.
export function appendThemeChoice(document,{select,picker,theme,label,selected=false,onChange}) {
  const option=document.createElement('option');option.value=theme;option.textContent=label;option.selected=selected;select.append(option);
  const button=document.createElement('button');button.type='button';button.className='theme-choice';button.textContent=label;button.dataset.themeValue=theme;
  button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));
  button.addEventListener('click',()=>{option.selected=!option.selected;button.classList.toggle('selected',option.selected);button.setAttribute('aria-pressed',String(option.selected));onChange?.([...select.selectedOptions].map(item=>item.value));});
  picker.append(button);return button;
}
