// Client — v6 full classic
const params = new URL(location.href).searchParams;
const roomHint = params.get("r") || undefined;
const roomLock = params.get("lock") === "1";

let persistedId = localStorage.getItem("anon_id");
if (!persistedId) { persistedId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); localStorage.setItem("anon_id", persistedId); }

const socket = io({
  path: "/realtime",
  transports: ['websocket','polling'],
  auth: { roomHint, roomLock, persistedId }
});

const chatEl = document.getElementById("chat");
const roomInfoEl = document.getElementById("roomInfo");
const typingEl = document.getElementById("typing");
const form = document.getElementById("composerForm");
const textInput = document.getElementById("textInput");
const fileInput = document.getElementById("fileInput");
const copyInviteBtn = document.getElementById("copyInvite");
const openSettingsBtn = document.getElementById("openSettings");
const settingsDlg = document.getElementById("settingsDlg");
const nickInput = document.getElementById("nickInput");
const topicInput = document.getElementById("topicInput");
const capInput = document.getElementById("capInput");
const lockInput = document.getElementById("lockInput");
const saveSettings = document.getElementById("saveSettings");
const emojiBtn = document.getElementById("emojiBtn");
const emojiDlg = document.getElementById("emojiDlg");
const emojiGrid = document.getElementById("emojiGrid");
const emojiClose = document.getElementById("emojiClose");
const recBtn = document.getElementById("recBtn");
const replyChip = document.getElementById("replyChip");

let me = { userId: "", name: "", roomId: "", owner: "" };
const pinnedSet = new Set();

function autolink(text){ const url=/\b(https?:\/\/[^\s<]+)\b/g; return text.replace(url, u=>`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); }
function tsToTime(ts){ const d=new Date(ts); return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}); }
function fmtBytes(bytes){ if(bytes==null) return ""; const s=["B","KB","MB","GB"]; const i=Math.floor(Math.log(bytes)/Math.log(1024)); return (bytes/Math.pow(1024,i)).toFixed(1)+" "+s[i]; }
function renderSystem(t){ const div=document.createElement("div"); div.className="system"; div.textContent=t; chatEl.appendChild(div); chatEl.scrollTop=chatEl.scrollHeight; }

function makeMsgEl(m){
  const wrap=document.createElement("div"); wrap.className="msg"+(m.userId===me.userId?" me":""); wrap.dataset.id=m.id;
  const av=document.createElement("div"); av.className="avatar"; av.textContent=(m.name||"A").slice(0,1).toUpperCase();
  const bubble=document.createElement("div"); bubble.className="bubble"; if (pinnedSet.has(m.id)) bubble.classList.add("pin");
  const meta=document.createElement("div"); meta.className="meta";
  const left=document.createElement("span"); left.textContent=`${m.name} • ${tsToTime(m.ts)}`; meta.appendChild(left);
  if (m.editedTs) { const e=document.createElement("span"); e.className="edited"; e.textContent="(edited)"; meta.appendChild(e); }
  const right=document.createElement("span");
  const replyBtn=document.createElement("button"); replyBtn.className="report-btn"; replyBtn.textContent="Reply"; replyBtn.onclick=()=>setReplyTo(m); right.appendChild(replyBtn);
  if (me.owner===me.userId){ const pinBtn=document.createElement("button"); pinBtn.className="report-btn"; pinBtn.textContent=pinnedSet.has(m.id)?"Unpin":"Pin"; pinBtn.onclick=()=>{ if(pinnedSet.has(m.id)) socket.emit("unpin",{messageId:m.id}); else socket.emit("pin",{messageId:m.id}); }; right.appendChild(document.createTextNode(" ")); right.appendChild(pinBtn); }
  if (m.userId===me.userId){
    const editBtn=document.createElement("button"); editBtn.className="report-btn"; editBtn.textContent="Edit"; editBtn.onclick=()=>{ const nt=prompt("Edit message:", m.text||""); if(nt==null) return; socket.emit("edit",{messageId:m.id,text:nt}); };
    const delBtn=document.createElement("button"); delBtn.className="report-btn"; delBtn.textContent="Delete"; delBtn.onclick=()=>socket.emit("delete",{messageId:m.id});
    right.appendChild(document.createTextNode(" ")); right.appendChild(editBtn); right.appendChild(document.createTextNode(" ")); right.appendChild(delBtn);
  } else {
    const repBtn=document.createElement("button"); repBtn.className="report-btn"; repBtn.textContent="Report"; repBtn.onclick=()=>{ const reason=prompt("Reason? (optional)")||""; socket.emit("report",{messageId:m.id,reason}); }; right.appendChild(document.createTextNode(" ")); right.appendChild(repBtn);
  }
  meta.appendChild(right); bubble.appendChild(meta);
  if (m.replyTo){ const r=document.createElement("div"); r.className="reply-chip"; r.textContent=`↩︎ ${m.replyTo.name}: ${(m.replyTo.text||"").slice(0,80)}`; bubble.appendChild(r); }
  if (m.text){ const body=document.createElement("div"); body.className="body"; const safe=(m.text||"").replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); body.innerHTML=autolink(safe); bubble.appendChild(body); }
  (m.files||[]).forEach(file=>{ const mt=(file.mimetype||"").toLowerCase();
    if (mt.startsWith("image/")){ const img=document.createElement("img"); img.src=file.url; bubble.appendChild(img); }
    else if (mt.startsWith("video/")){ const v=document.createElement("video"); v.src=file.url; v.controls=true; bubble.appendChild(v); }
    else if (mt.startsWith("audio/")){ const a=document.createElement("audio"); a.src=file.url; a.controls=true; bubble.appendChild(a); }
    else { const pill=document.createElement("a"); pill.href=file.url; pill.target="_blank"; pill.rel="noopener"; pill.className="file-pill"; pill.innerHTML=`<span>📄</span><span class="name">${file.originalName||"file"}</span><span class="size">${fmtBytes(file.size)}</span>`; bubble.appendChild(pill); }
  });
  wrap.appendChild(av); wrap.appendChild(bubble); return wrap;
}
function renderMsg(m){ chatEl.appendChild(makeMsgEl(m)); chatEl.scrollTop = chatEl.scrollHeight; }

// Reply chip
let replyTo = null;
const replyChip = document.getElementById("replyChip");
function setReplyTo(m){
  replyTo = { id: m.id, name: m.name, text: m.text };
  replyChip.hidden = false;
  replyChip.textContent = `Replying to ${m.name}: ${(m.text||"").slice(0,60)}`;
  const x = document.createElement("button"); x.textContent = "×"; x.onclick = () => { replyTo = null; replyChip.hidden = true; replyChip.textContent=""; };
  replyChip.appendChild(document.createTextNode(" ")); replyChip.appendChild(x);
}

// Socket events
socket.on("connect_error", (e)=>{ roomInfoEl.textContent="Connection error"; console.error(e); });
socket.on("hello", ({ roomId, anonName, userId, topic, capacity, locked, owner }) => {
  me = { roomId, name: anonName, userId, owner };
  roomInfoEl.textContent = `Room ${roomId}${topic ? " • " + topic : ""}`;
  topicInput.value = topic || ""; capInput.value = capacity || 50; lockInput.checked = !!locked;
  copyInviteBtn.onclick = async () => { const url = `${location.origin}${location.pathname}?r=${encodeURIComponent(roomId)}${lockInput.checked ? "&lock=1":""}`; await navigator.clipboard.writeText(url); copyInviteBtn.textContent="Copied!"; setTimeout(()=> copyInviteBtn.textContent="Copy invite", 1200); };
  const savedNick = localStorage.getItem("anon_nick"); if (savedNick) socket.emit("setNick", savedNick);
});
socket.on("pins", ({ ids }) => { pinnedSet.clear(); (ids||[]).forEach(id=>pinnedSet.add(id)); });
socket.on("history", items => items.forEach(renderMsg));
socket.on("msg", m => renderMsg(m));
socket.on("edited", ({ messageId, text, editedTs }) => {
  const el = chatEl.querySelector(`.msg[data-id="${messageId}"]`); if(!el) return;
  const body=el.querySelector(".body"); if(body) body.innerHTML=autolink(text.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])));
  let e=el.querySelector(".edited"); if(!e){ e=document.createElement("span"); e.className="edited"; el.querySelector(".meta").appendChild(e); } e.textContent="(edited)";
});
socket.on("pinned", ({ messageId }) => { pinnedSet.add(messageId); const el=chatEl.querySelector(`.msg[data-id="${messageId}"]`); if(el) el.querySelector(".bubble").classList.add("pin"); });
socket.on("unpinned", ({ messageId }) => { pinnedSet.delete(messageId); const el=chatEl.querySelector(`.msg[data-id="${messageId}"]`); if(el) el.querySelector(".bubble").classList.remove("pin"); });
socket.on("typing", ({ name }) => { const t=document.getElementById("typing"); t.textContent=`${name} is typing…`; clearTimeout(window._tt); window._tt=setTimeout(()=>t.textContent="", 1200); });
socket.on("presence", p => { const msg = (p.type==="join") ? `Someone joined • ${p.count} online` : `Someone left • ${p.count} online`; renderSystem(msg); });
socket.on("errorMsg", t => renderSystem(`⚠️ ${t}`));
socket.on("deleted", ({ messageId }) => { const el=chatEl.querySelector(`.msg[data-id="${messageId}"]`); if(el) el.remove(); });

// Send
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  const files = Array.from(fileInput.files || []);
  let metas = [];
  if (files.length) {
    const fd = new FormData(); files.slice(0,4).forEach(f=>fd.append("files", f));
    try { const res = await fetch("/api/upload", { method:"POST", body: fd }); const info = await res.json(); metas = info.files || []; }
    catch { renderSystem("⚠️ Upload failed"); return; }
    finally { fileInput.value = ""; }
  }
  if (!text && !metas.length) return;
  socket.emit("msg", { text, files: metas, replyTo });
  textInput.value=""; replyTo=null; replyChip.hidden=true; replyChip.textContent="";
});

// Typing
let lastTyped=0;
textInput.addEventListener("input", ()=>{ const n=Date.now(); if(n-lastTyped>600){ socket.emit("typing"); lastTyped=n; } });

// Settings
openSettingsBtn.onclick=()=>{ const savedNick=localStorage.getItem("anon_nick"); if(savedNick) nickInput.value=savedNick; settingsDlg.showModal(); };
saveSettings.onclick=(e)=>{ e.preventDefault(); const nick=nickInput.value.trim(); if(nick){ localStorage.setItem("anon_nick", nick); socket.emit("setNick", nick); } const topic=topicInput.value.trim(); const cap=parseInt(capInput.value||"50",10); const locked=lockInput.checked; socket.emit("setRoom",{topic, capacity:cap, locked}); settingsDlg.close(); };

// Emoji
const EMOJI=["😀","😁","😂","🤣","😊","😍","😘","😜","🤔","😎","😢","😡","👍","👎","🙏","👏","🔥","💯","💀","🤝","❤️","🧡","💛","💚","💙","💜","🤍","🤎"];
emojiBtn.onclick=()=>{ if(!emojiDlg.open){ if(!emojiGrid.childElementCount){ EMOJI.forEach(e=>{ const b=document.createElement("button"); b.textContent=e; b.onclick=(ev)=>{ ev.preventDefault(); textInput.value+=e; }; emojiGrid.appendChild(b); }); } emojiDlg.showModal(); } };
emojiClose.onclick=()=>emojiDlg.close();

// Voice
let recording=false, mediaRecorder=null, chunks=[];
recBtn.onclick=async()=>{ if(!recording){ try{ const stream=await navigator.mediaDevices.getUserMedia({audio:true}); chunks=[]; mediaRecorder=new MediaRecorder(stream); mediaRecorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); }; mediaRecorder.onstop=async()=>{ const blob=new Blob(chunks,{type:"audio/webm"}); const file=new File([blob],"voice.webm",{type:"audio/webm"}); const fd=new FormData(); fd.append("files",file); try{ const r=await fetch("/api/upload",{method:"POST", body:fd}); const info=await r.json(); socket.emit("msg",{ text:"", files:info.files||[] }); }catch{ renderSystem("⚠️ Voice upload failed"); } }; mediaRecorder.start(); recording=true; recBtn.textContent="⏹ Stop"; } catch{ renderSystem("⚠️ Microphone blocked"); } } else { mediaRecorder.stop(); recording=false; recBtn.textContent="🎤"; } };
