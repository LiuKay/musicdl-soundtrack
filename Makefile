PYTHON ?= .venv/bin/python

.PHONY: app test

app:
	$(PYTHON) -m pip install pywebview==6.2.1 py2app==0.28.10
	rm -rf build dist/Soundtrack.app
	$(PYTHON) setup.py -q py2app

test:
	$(PYTHON) -m unittest -v test_app.py
