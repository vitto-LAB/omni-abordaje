'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const rooms = new Map();
const clients = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(){ let s=''; do { s=''; for(let i=0;i<6;i++) s+=alphabet[Math.floor(Math.random()*alphabet.length)]; } while(rooms.has(s)); return s; }
function send(ws,obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function roomPlayers(room){ return [...room.players.values()].map(p=>({id:p.id,name:p.name,isHost:p.isHost,connected:true,downed:!!p.downed,hp:p.hp??100,medCount:p.medCount??0})); }
function broadcast(room,obj,except=null){ for(const p of room.players.values()) if(p.ws!==except) send(p.ws,obj); }
function lobby(room,type='lobby'){ broadcast(room,{type,room:room.code,max:room.max,players:roomPlayers(room),started:room.started}); }
function leave(ws){
  const c=clients.get(ws); if(!c)return; clients.delete(ws);
  const room=rooms.get(c.room); if(!room)return;
  const p=room.players.get(c.id); if(!p)return;
  room.players.delete(c.id);
  if(p.isHost){ broadcast(room,{type:'roomClosed',reason:'host-left'}); for(const other of room.players.values()){clients.delete(other.ws);try{other.ws.close();}catch(_){}} room.players.clear(); rooms.delete(room.code); return; }
  lobby(room,'playerLeft');
}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,service:'omni-abordaje-room-server',rooms:rooms.size}));return;}
  let file=url.pathname==='/'?path.join(ROOT,'omni_abordaje_v5_0.html'):path.join(ROOT,path.basename(decodeURIComponent(url.pathname)));
  if(!file.startsWith(ROOT)){res.writeHead(403);res.end('Forbidden');return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end('Not found');return;}const ext=path.extname(file);const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(data);});
});
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch(_){send(ws,{type:'error',message:'Mensaje inválido.'});return;}
    const c=clients.get(ws);
    if(m.type==='create'){
      if(c){send(ws,{type:'error',message:'Ya estás conectado a una sala.'});return;}
      const max=Math.max(2,Math.min(4,Number(m.max)||4));const roomCode=code();const id='p_'+Math.random().toString(36).slice(2,10);
      const room={code:roomCode,max,difficulty:['facil','normal','dificil'].includes(m.difficulty)?m.difficulty:'normal',seed:Number(m.seed)>>>0,hostId:id,started:false,players:new Map()};
      const player={id,name:String(m.name||'HOST').slice(0,18),isHost:true,ws,hp:100,downed:false,medCount:0,x:-12,y:1.7,z:-84,yaw:-.785,pitch:0};room.players.set(id,player);rooms.set(roomCode,room);clients.set(ws,{room:roomCode,id});
      send(ws,{type:'roomCreated',code:roomCode,id,max,seed:room.seed,difficulty:room.difficulty});lobby(room);return;
    }
    if(m.type==='join'){
      if(c){send(ws,{type:'error',message:'Ya estás conectado a una sala.'});return;}
      const room=rooms.get(String(m.code||'').toUpperCase());if(!room){send(ws,{type:'error',message:'No existe una sala con ese código.'});return;}
      if(room.started){send(ws,{type:'error',message:'La partida ya comenzó.'});return;}
      if(room.players.size>=room.max){send(ws,{type:'error',message:'La sala está llena.'});return;}
      const id='p_'+Math.random().toString(36).slice(2,10);const player={id,name:String(m.name||'JUGADOR').slice(0,18),isHost:false,ws,hp:100,downed:false,medCount:0,x:-12,y:1.7,z:-84,yaw:-.785,pitch:0};room.players.set(id,player);clients.set(ws,{room:room.code,id});
      send(ws,{type:'joined',code:room.code,id,max:room.max,seed:room.seed,difficulty:room.difficulty,started:room.started});lobby(room,'playerJoined');return;
    }
    if(!c){send(ws,{type:'error',message:'Primero debes crear o unirte a una sala.'});return;}
    const room=rooms.get(c.room);const player=room&&room.players.get(c.id);if(!room||!player){send(ws,{type:'error',message:'La sala ya no existe.'});return;}
    if(m.type==='start'){
      if(!player.isHost){send(ws,{type:'error',message:'Solo el host puede iniciar.'});return;}
      room.started=true;room.difficulty=['facil','normal','dificil'].includes(m.difficulty)?m.difficulty:room.difficulty;
      broadcast(room,{type:'started',seed:room.seed,difficulty:room.difficulty,max:room.max});return;
    }
    if(m.type==='playerUpdate'){
      const q=m.player||{};player.x=Number(q.x)||0;player.y=Number(q.y)||0;player.z=Number(q.z)||0;player.yaw=Number(q.yaw)||0;player.pitch=Number(q.pitch)||0;
      if(player.isHost){player.hp=Number(q.hp)||player.hp;player.downed=!!q.downed;player.medCount=Math.max(0,Number(q.medCount)||0);}
      broadcast(room,{type:'playerUpdate',player:{id:player.id,name:player.name,isHost:player.isHost,x:player.x,y:player.y,z:player.z,yaw:player.yaw,pitch:player.pitch,hp:player.hp,downed:player.downed,medCount:player.medCount,connected:true}});return;
    }
    if(m.type==='worldState'){
      if(!player.isHost)return;
      // El estado de vida/inventario de clientes no lo decide el navegador del propio jugador.
      const st=m.state||{};if(Array.isArray(st.players)){for(const q of st.players){const p=room.players.get(q.id);if(p&&p.isHost){p.hp=Number(q.hp)||p.hp;p.downed=!!q.downed;p.medCount=Math.max(0,Number(q.medCount)||0);}}}
      broadcast(room,{type:'worldState',state:st},ws);return;
    }
    if(['shoot','pickupRequest','reviveRequest','healRequest','inventoryUpdate'].includes(m.type)){
      const host=room.players.get(room.hostId);if(host)send(host.ws,{...m,id:player.id});return;
    }
    if(m.type==='leave'){leave(ws);try{ws.close();}catch(_){}return;}
  });
  ws.on('close',()=>leave(ws));ws.on('error',()=>leave(ws));
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Omni room server listening on http://0.0.0.0:${PORT}`));
