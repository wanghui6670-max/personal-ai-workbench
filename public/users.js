const toastEl=document.getElementById('toast');
function toast(msg,error=false){toastEl.textContent=msg;toastEl.className='toast show'+(error?' error':'');clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.className='toast',2600);}

async function api(url,opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'请求失败');return data;}

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function loadUsers(){
  try{
    const data=await api('/api/users');
    const list=document.getElementById('users-list');
    if(!data.users||data.users.length===0){list.innerHTML='<p style="color:var(--muted);text-align:center;padding:20px">暂无用户</p>';return;}
    list.innerHTML=data.users.map(u=>`<div class="user-card"><div class="user-avatar">${esc(u.username.charAt(0).toUpperCase())}</div><div class="user-info"><div class="name">${esc(u.username)}<span class="role-badge ${u.role}">${u.role==='admin'?'管理员':'用户'}</span></div><div class="meta">${esc(u.displayName||'')} · 创建于 ${esc(u.createdAt||'')}</div></div><div class="user-actions"><button class="btn" data-action="view-data" data-uid="${esc(u.id)}" data-uname="${esc(u.username)}" data-dname="${esc(u.displayName||'')}">查看数据</button><button class="btn" data-action="change-password" data-uid="${esc(u.id)}">改密码</button><button class="btn" data-action="edit" data-uid="${esc(u.id)}">编辑</button>${u.role!=='admin'||data.users.filter(x=>x.role==='admin').length>1?`<button class="btn danger" data-action="delete" data-uid="${esc(u.id)}" data-uname="${esc(u.username)}">删除</button>`:''}</div></div>`).join('');
  }catch(e){toast(e.message,true);}
}

document.getElementById('add-user-btn').addEventListener('click',async()=>{
  const username=document.getElementById('new-username').value.trim();
  const displayName=document.getElementById('new-display-name').value.trim();
  const password=document.getElementById('new-password').value;
  const role=document.getElementById('new-role').value;
  if(!username||!password){toast('请输入用户名和密码',true);return;}
  try{
    await api('/api/users',{method:'POST',body:JSON.stringify({username,password,displayName,role})});
    document.getElementById('new-username').value='';
    document.getElementById('new-display-name').value='';
    document.getElementById('new-password').value='';
    toast('用户已创建');
    await loadUsers();
  }catch(e){toast(e.message,true);}
});

// 事件委托：处理用户列表中的按钮点击
document.getElementById('users-list').addEventListener('click',async(e)=>{
  const btn=e.target.closest('button[data-action]');
  if(!btn)return;
  const action=btn.dataset.action;
  const uid=btn.dataset.uid;
  const uname=btn.dataset.uname;
  const dname=btn.dataset.dname;
  if(action==='view-data'){viewUserData(uid,uname,dname);}
  else if(action==='change-password'){changePassword(uid);}
  else if(action==='edit'){editUser(uid);}
  else if(action==='delete'){deleteUser(uid,uname);}
});

async function changePassword(userId){
  const modal=document.createElement('div');
  modal.className='modal-overlay';
  modal.innerHTML=`<div class="modal-box"><h3>修改密码</h3><input id="mp-old" type="password" placeholder="旧密码"><input id="mp-new" type="password" placeholder="新密码"><input id="mp-confirm" type="password" placeholder="确认新密码"><div class="modal-actions"><button class="btn" id="mp-cancel">取消</button><button class="btn primary" id="mp-save">保存</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#mp-cancel').addEventListener('click',()=>modal.remove());
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
  modal.querySelector('#mp-save').addEventListener('click',async()=>{
    const oldP=modal.querySelector('#mp-old').value;
    const newP=modal.querySelector('#mp-new').value;
    const confirmP=modal.querySelector('#mp-confirm').value;
    if(newP!==confirmP){toast('两次输入的新密码不一致',true);return;}
    if(!newP){toast('请输入新密码',true);return;}
    try{
      await api(`/api/users/${userId}/password`,{method:'POST',body:JSON.stringify({oldPassword:oldP,newPassword:newP})});
      modal.remove();
      toast('密码已修改');
    }catch(e){toast(e.message,true);}
  });
}

async function editUser(userId){
  const newName=prompt('新的显示名称：');
  if(newName===null)return;
  try{
    await api(`/api/users/${userId}`,{method:'PATCH',body:JSON.stringify({displayName:newName})});
    toast('用户信息已更新');
    await loadUsers();
  }catch(e){toast(e.message,true);}
}

async function deleteUser(userId,username){
  if(!confirm(`确认删除用户 "${username}"？此操作不可恢复。`))return;
  try{
    await api(`/api/users/${userId}`,{method:'DELETE'});
    toast('用户已删除');
    await loadUsers();
  }catch(e){toast(e.message,true);}
}

async function viewUserData(userId,username,displayName){
  const modal=document.createElement('div');
  modal.className='modal-overlay';
  modal.innerHTML=`<div class="data-modal"><div class="data-modal-head"><h3>${esc(username)} 的数据</h3><button class="close-btn" id="dm-close">✕</button></div><div class="data-modal-body"><div style="text-align:center;padding:20px;color:var(--muted)">加载中…</div></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#dm-close').addEventListener('click',()=>modal.remove());
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
  try{
    const data=await api(`/api/admin/users/${userId}/state`);
    const s=data.state||{};
    const todos=s.todos||[];
    const inbox=s.inbox||[];
    const projects=s.projects||[];
    const activities=s.activities||[];
    const businesses=s.businesses||[];
    const body=modal.querySelector('.data-modal-body');
    const overdue=s.stats?.overdue||0;
    const todayCount=(s.todayTodos||[]).length;
    body.innerHTML=`
      <div class="stat-grid">
        <div class="stat-box"><div class="num">${todos.length}</div><div class="label">待办</div></div>
        <div class="stat-box"><div class="num">${inbox.length}</div><div class="label">收件箱</div></div>
        <div class="stat-box"><div class="num">${projects.length}</div><div class="label">项目</div></div>
        <div class="stat-box"><div class="num">${activities.length}</div><div class="label">工作日志</div></div>
      </div>
      <div class="stat-grid">
        <div class="stat-box"><div class="num">${todayCount}</div><div class="label">今日待办</div></div>
        <div class="stat-box"><div class="num">${overdue}</div><div class="label">逾期</div></div>
        <div class="stat-box"><div class="num">${(s.confirmations||[]).length}</div><div class="label">待确认</div></div>
        <div class="stat-box"><div class="num">${businesses.length}</div><div class="label">业务板块</div></div>
      </div>
      <div class="data-section"><h4>项目 <span class="count">(${projects.length})</span></h4>${projects.length?projects.map(p=>`<div class="data-item"><div class="item-title">${esc(p.name)}</div><div class="item-meta">${esc(p.status||'进行中')} · 进度 ${p.progress||0}%${p.endDate?` · 截止 ${esc(p.endDate)}`:''}</div></div>`).join(''):'<div class="empty-data">暂无项目</div>'}</div>
      <div class="data-section"><h4>待办 <span class="count">(${todos.length})</span></h4>${todos.length?todos.map(t=>`<div class="data-item"><div class="item-title">${esc(t.title)}${t.done?'<span class="pill-sm done">已完成</span>':t.dueDate?'<span class="pill-sm pending">待处理</span>':'<span class="pill-sm pending">无截止</span>'}</div><div class="item-meta">${t.project?esc(t.project):'独立待办'}${t.dueDate?` · 截止 ${esc(t.dueDate)}`:''}</div></div>`).join(''):'<div class="empty-data">暂无待办</div>'}</div>
      <div class="data-section"><h4>收件箱 <span class="count">(${inbox.length})</span></h4>${inbox.length?inbox.map(i=>`<div class="data-item"><div class="item-title">${esc(i.text)}</div><div class="item-meta">${esc(i.source||'manual')}${i.createdAt?` · ${esc(i.createdAt.slice(0,10))}`:''}</div></div>`).join(''):'<div class="empty-data">收件箱为空</div>'}</div>
      <div class="data-section"><h4>最近工作日志 <span class="count">(${activities.length})</span></h4>${activities.length?activities.slice(0,15).map(a=>`<div class="data-item"><div class="item-title">${esc(a.text)}</div><div class="item-meta">${esc(a.at?String(a.at).slice(0,16):'')}</div></div>`).join(''):'<div class="empty-data">暂无工作日志</div>'}</div>`;
  }catch(e){
    modal.querySelector('.data-modal-body').innerHTML=`<div style="text-align:center;padding:20px;color:var(--danger)">${esc(e.message)}</div>`;
  }
}

loadUsers();
