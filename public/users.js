const {esc,json:api,toast,setupModal}=window.WB;

let allUsers=[];
let selectedIds=new Set();

async function loadUsers(){
  try{
    const data=await api('/api/users');
    allUsers=data.users||[];
    selectedIds.clear();
    renderUsers();
  }catch(e){toast(e.message,true);}
}

function getFilteredUsers(){
  const q=document.getElementById('search-input').value.trim().toLowerCase();
  if(!q)return allUsers;
  return allUsers.filter(u=>(u.username||'').toLowerCase().includes(q)||(u.displayName||'').toLowerCase().includes(q));
}

function renderUsers(){
  const list=document.getElementById('users-list');
  const filtered=getFilteredUsers();
  const adminCount=allUsers.filter(x=>x.role==='admin').length;

  if(filtered.length===0){
    list.innerHTML='<p style="color:var(--muted);text-align:center;padding:20px">'+(allUsers.length===0?'暂无用户':'无匹配结果')+'</p>';
    updateBatchBar();
    return;
  }

  list.innerHTML=filtered.map(u=>{
    const canDelete=u.role!=='admin'||adminCount>1;
    return `<div class="user-card" data-uid="${esc(u.id)}">
      <input type="checkbox" class="user-checkbox" id="user-check-${esc(u.id)}" data-uid="${esc(u.id)}" aria-label="选择用户 ${esc(u.username)}" ${selectedIds.has(u.id)?'checked':''}>
      <div class="user-avatar">${esc(u.username.charAt(0).toUpperCase())}</div>
      <div class="user-info">
        <div class="name">${esc(u.username)}<span class="role-badge ${u.role}">${u.role==='admin'?'管理员':'用户'}</span></div>
        <div class="meta">${esc(u.displayName||'')} · 创建于 ${esc((u.createdAt||'').slice(0,10))}${u.lastSeenAt?` · 最近活跃 ${esc(u.lastSeenAt.slice(0,16).replace('T',' '))}`:' · 未活跃'}</div>
      </div>
      <div class="user-actions">
        <button class="btn" data-action="view-data" data-uid="${esc(u.id)}" data-uname="${esc(u.username)}" data-dname="${esc(u.displayName||'')}">查看数据</button>
        <button class="btn" data-action="change-password" data-uid="${esc(u.id)}">改密码</button>
        <button class="btn" data-action="edit" data-uid="${esc(u.id)}" data-dname="${esc(u.displayName||'')}" data-role="${esc(u.role)}">编辑</button>
        ${canDelete?`<button class="btn danger" data-action="delete" data-uid="${esc(u.id)}" data-uname="${esc(u.username)}">删除</button>`:''}
      </div>
    </div>`;
  }).join('');

  // 绑定 checkbox 事件
  list.querySelectorAll('.user-checkbox').forEach(cb=>{
    cb.addEventListener('change',e=>{
      const uid=e.target.dataset.uid;
      if(e.target.checked)selectedIds.add(uid);else selectedIds.delete(uid);
      updateBatchBar();
    });
  });

  updateBatchBar();
}

function updateBatchBar(){
  const bar=document.getElementById('batch-bar');
  const count=selectedIds.size;
  if(count>0){
    bar.style.display='flex';
    bar.querySelector('.batch-count').textContent=`已选择 ${count} 个用户`;
  }else{
    bar.style.display='none';
  }
}

// 搜索
document.getElementById('search-input').addEventListener('input',()=>renderUsers());

// 全选/取消全选
document.getElementById('select-all-btn').addEventListener('click',()=>{
  const filtered=getFilteredUsers();
  if(selectedIds.size>=filtered.length){
    selectedIds.clear();
  }else{
    filtered.forEach(u=>selectedIds.add(u.id));
  }
  renderUsers();
});

// 批量删除
document.getElementById('batch-delete-btn').addEventListener('click',async()=>{
  if(selectedIds.size===0)return;
  if(!confirm(`确认删除选中的 ${selectedIds.size} 个用户？此操作不可恢复。`))return;
  const errors=[];
  for(const uid of selectedIds){
    try{await api(`/api/users/${uid}`,{method:'DELETE'});}
    catch(e){errors.push(uid+': '+e.message);}
  }
  if(errors.length){toast(`${errors.length} 个用户删除失败`,true);}
  else{toast(`已删除 ${selectedIds.size} 个用户`);}
  await loadUsers();
});

// 添加用户
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
  const role=btn.dataset.role;
  if(action==='view-data'){viewUserData(uid,uname,dname);}
  else if(action==='change-password'){changePassword(uid);}
  else if(action==='edit'){editUser(uid,dname,role);}
  else if(action==='delete'){deleteUser(uid,uname);}
});

async function changePassword(userId){
  const modal=document.createElement('div');
  modal.className='modal-overlay';
  modal.innerHTML=`<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="mp-title"><h3 id="mp-title">修改密码</h3><label class="field-label" for="mp-old">旧密码</label><input id="mp-old" type="password" placeholder="旧密码" autocomplete="current-password"><label class="field-label" for="mp-new">新密码（至少8位，含字母和数字）</label><input id="mp-new" type="password" placeholder="新密码（至少8位，含字母和数字）" autocomplete="new-password"><label class="field-label" for="mp-confirm">确认新密码</label><input id="mp-confirm" type="password" placeholder="确认新密码" autocomplete="new-password"><div class="modal-actions"><button class="btn" id="mp-cancel">取消</button><button class="btn primary" id="mp-save">保存</button></div></div>`;
  document.body.appendChild(modal);
  const mpCleanup=setupModal(modal,()=>modal.remove());
  modal.querySelector('#mp-cancel').addEventListener('click',()=>{mpCleanup();modal.remove();});
  modal.addEventListener('click',e=>{if(e.target===modal){mpCleanup();modal.remove();}});
  modal.querySelector('#mp-save').addEventListener('click',async()=>{
    const oldP=modal.querySelector('#mp-old').value;
    const newP=modal.querySelector('#mp-new').value;
    const confirmP=modal.querySelector('#mp-confirm').value;
    if(newP!==confirmP){toast('两次输入的新密码不一致',true);return;}
    if(!newP){toast('请输入新密码',true);return;}
    if(newP.length<8){toast('密码至少 8 个字符',true);return;}
    if(!/[a-zA-Z]/.test(newP)||!/[0-9]/.test(newP)){toast('密码必须包含字母和数字',true);return;}
    try{
      await api(`/api/users/${userId}/password`,{method:'POST',body:JSON.stringify({oldPassword:oldP,newPassword:newP})});
      mpCleanup();modal.remove();
      toast('密码已修改');
    }catch(e){toast(e.message,true);}
  });
}

async function editUser(userId,displayName,role){
  const modal=document.createElement('div');
  modal.className='modal-overlay';
  modal.innerHTML=`<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="eu-title"><h3 id="eu-title">编辑用户</h3>
    <label class="field-label" for="eu-dname">显示名称</label>
    <input id="eu-dname" type="text" value="${esc(displayName)}" placeholder="显示名称">
    <label class="field-label" for="eu-role">角色</label>
    <select id="eu-role" style="width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;margin-bottom:12px">
      <option value="member" ${role==='member'?'selected':''}>普通用户</option>
      <option value="admin" ${role==='admin'?'selected':''}>管理员</option>
    </select>
    <div class="modal-actions"><button class="btn" id="eu-cancel">取消</button><button class="btn primary" id="eu-save">保存</button></div>
  </div>`;
  document.body.appendChild(modal);
  const euCleanup=setupModal(modal,()=>modal.remove());
  modal.querySelector('#eu-cancel').addEventListener('click',()=>{euCleanup();modal.remove();});
  modal.addEventListener('click',e=>{if(e.target===modal){euCleanup();modal.remove();}});
  modal.querySelector('#eu-save').addEventListener('click',async()=>{
    const newName=modal.querySelector('#eu-dname').value.trim();
    const newRole=modal.querySelector('#eu-role').value;
    try{
      await api(`/api/users/${userId}`,{method:'PATCH',body:JSON.stringify({displayName:newName,role:newRole})});
      euCleanup();modal.remove();
      toast('用户信息已更新');
      await loadUsers();
    }catch(e){toast(e.message,true);}
  });
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
  modal.innerHTML=`<div class="data-modal" role="dialog" aria-modal="true" aria-labelledby="dm-title"><div class="data-modal-head"><h3 id="dm-title">${esc(username)} 的数据</h3><button class="close-btn" id="dm-close" aria-label="关闭">✕</button></div><div class="data-modal-body"><div style="text-align:center;padding:20px;color:var(--muted)">加载中…</div></div></div>`;
  document.body.appendChild(modal);
  const dmCleanup=setupModal(modal,()=>modal.remove());
  modal.querySelector('#dm-close').addEventListener('click',()=>{dmCleanup();modal.remove();});
  modal.addEventListener('click',e=>{if(e.target===modal){dmCleanup();modal.remove();}});
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
