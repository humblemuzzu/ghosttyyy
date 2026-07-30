import json,sys
calls=[];final="";err=""
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    t=d.get("type")
    if t=="message_update":
        ev=d.get("assistantMessageEvent",{})
        if ev.get("type")=="toolCall_start":
            calls.append(ev.get("partial",{}).get("content",[{}])[-1].get("name","?"))
    if t=="turn_end":
        for c in d.get("message",{}).get("content",[]):
            if c.get("type")=="toolCall": calls.append(c.get("name","?"))
            if c.get("type")=="text": final=c.get("text","")
        for tr in d.get("toolResults",[]):
            if tr.get("isError"): err+=str(tr.get("content"))[:200]
print("TOOL_CALLS:",calls if calls else "NONE")
print("ERRORS:",err[:300] if err else "none")
print("FINAL:",final[:300])
