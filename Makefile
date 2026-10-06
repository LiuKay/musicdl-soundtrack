PYTHON ?= .venv/bin/python

.PHONY: app test audio-tools

audio-tools:
	bash scripts/build-audio-tools.sh

app: audio-tools
	$(PYTHON) -m pip install pywebview==6.2.1 py2app==0.28.10
	rm -rf build/py2app dist/Soundtrack.app
	$(PYTHON) setup.py -q py2app --bdist-base build/py2app

test:
	$(PYTHON) -m unittest -v test_app.py test_audio_formats.py test_download_workflow.py
	node --test test_ui.cjs test_session.cjs
