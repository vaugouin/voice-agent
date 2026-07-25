FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY VERSION .
# The persona is content, not code: SOUL.md (default persona) and souls/ (the core rules plus
# the alternates) are read at import from ROOT.parent, i.e. /app. Without these two lines the
# image has no soul file at all and the agent silently degrades to the operational-only prompt
# (the loaders fall back to ""), which is exactly what would have shipped with VOICE-AGENT-103.
COPY SOUL.md .
COPY souls ./souls
COPY app ./app

RUN mkdir -p /app/logs

EXPOSE 3000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
