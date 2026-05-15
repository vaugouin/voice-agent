docker ps --filter "name=voice-agent"

docker stop voice-agent

cd /home/debian/docker/voice-agent
clear

docker build -t voice-agent:latest .

docker rm -f voice-agent 2>/dev/null || true

docker run -d \
  --name voice-agent \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file /home/debian/docker/voice-agent/.env \
  -v /home/debian/docker/voice-agent/logs:/app/logs \
  voice-agent:latest

docker logs -f voice-agent
